import { Env, Send, SendAuthType, SendType } from '../types';
import { StorageService } from '../services/storage';
import { jsonResponse, errorResponse } from '../utils/response';
import { buildDirectUploadUrl, getSafeJwtSecret, parseDirectUploadPayload } from '../utils/direct-upload';
import { generateUUID } from '../utils/uuid';
import { parsePagination, encodeContinuationToken } from '../utils/pagination';
import { LIMITS } from '../config/limits';
import {
  getBlobStorageMaxBytes,
  getSendFileObjectKey,
  getBlobObject,
  putBlobObject,
  deleteBlobObject,
} from '../services/blob-store';
import { createSendFileUploadToken, verifySendFileUploadToken } from '../utils/jwt';
import {
  formatSize,
  getAliasedProp,
  parseSendEmails,
  notifySendCreateForRequest,
  notifySendDeleteForRequest,
  notifySendUpdateForRequest,
  notifyVaultSyncForRequest,
  parseDate,
  parseFileLength,
  parseInteger,
  parseMaxAccessCount,
  parseSendAuthType,
  parseSendType,
  parseStoredSendData,
  sanitizeSendData,
  sendToResponse,
  setSendPassword,
  validateDeletionDate,
} from './sends-shared';
import { auditRequestMetadata, writeAuditEvent } from '../services/audit-events';
import { isMailDeliveryAvailableSoft } from '../services/mail-settings';
import { clearSendOtpsForSend } from '../services/send-email-otp';

/** 名单不合法时的统一响应。⚠️ 上限是字面量（guard 禁插值）⇒ 改 `SEND_EMAIL_LIST_MAX` 时必须同步改。 */
function sendEmailListErrorResponse(reason: 'invalid' | 'too-many'): Response {
  return reason === 'too-many'
    ? errorResponse('Too many email addresses (max 20)', 400)
    : errorResponse('Invalid emails', 400);
}

/** 邮箱认证的 Send 依赖服务端能发信（发不出去等于谁都打不开）⇒ 保存前先确认邮件可用。 */
async function requireMailDeliveryForEmailSend(env: Env): Promise<Response | null> {
  if (await isMailDeliveryAvailableSoft(env)) return null;
  return errorResponse(
    'Email delivery is not configured on this server, so a Send limited to specific email addresses cannot be saved',
    503
  );
}

async function writeSendAudit(
  storage: StorageService,
  request: Request,
  userId: string,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await writeAuditEvent(storage, {
    actorUserId: userId,
    action,
    category: 'data',
    level: action.includes('delete') ? 'security' : 'info',
    targetType: 'send',
    targetId: typeof metadata.id === 'string' ? metadata.id : null,
    metadata: {
      ...metadata,
      ...auditRequestMetadata(request),
    },
  });
}

async function processSendFileUpload(
  request: Request,
  env: Env,
  send: Send,
  fileId: string
): Promise<Response> {
  const maxFileSize = getBlobStorageMaxBytes(env, LIMITS.send.maxFileSizeBytes);
  const sendData = parseStoredSendData(send);
  const expectedFileId = typeof sendData.id === 'string' ? sendData.id : null;
  if (!expectedFileId || expectedFileId !== fileId) {
    return errorResponse('Send file does not match send data.', 400);
  }

  const expectedFileName = typeof sendData.fileName === 'string' ? sendData.fileName : null;
  const expectedSize = parseInteger(sendData.size);
  const upload = await parseDirectUploadPayload(request, {
    expectedSize,
    expectedFileName,
    maxFileSize,
    tooLargeMessage: 'Send storage limit exceeded with this file',
    sizeMismatchMessage: 'Send file size does not match.',
    fileNameMismatchMessage: 'Send file name does not match.',
  });
  if (upload instanceof Response) {
    return upload;
  }

  const path = getSendFileObjectKey(send.id, fileId);
  if (await getBlobObject(env, path)) {
    return errorResponse('Send file has already been uploaded', 409);
  }

  try {
    await putBlobObject(env, path, upload.body, {
      size: upload.size,
      contentType: upload.contentType,
      customMetadata: {
        sendId: send.id,
        fileId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('KV object too large')) {
      return errorResponse('Send storage limit exceeded with this file', 413);
    }
    return errorResponse('Attachment storage is not configured', 500);
  }

  const storage = new StorageService(env.DB);
  const revisionDate = await storage.updateRevisionDate(send.userId);
  notifyVaultSyncForRequest(request, env, send.userId, revisionDate);
  notifySendUpdateForRequest(request, env, send.id, send.userId, revisionDate);

  return new Response(null, { status: 201 });
}

export async function handleGetSends(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const url = new URL(request.url);
  const pagination = parsePagination(url);

  let sends: Send[];
  let continuationToken: string | null = null;
  if (pagination) {
    const pageRows = await storage.getSendsPage(userId, pagination.limit + 1, pagination.offset);
    const hasNext = pageRows.length > pagination.limit;
    sends = hasNext ? pageRows.slice(0, pagination.limit) : pageRows;
    continuationToken = hasNext ? encodeContinuationToken(pagination.offset + sends.length) : null;
  } else {
    sends = await storage.getAllSends(userId);
  }

  const sendResponses = sends.map(sendToResponse);
  return jsonResponse({
    data: sendResponses,
    object: 'list',
    continuationToken,
  });
}

export async function handleGetSend(request: Request, env: Env, userId: string, sendId: string): Promise<Response> {
  void request;
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);

  if (!send || send.userId !== userId) {
    return errorResponse('Send not found', 404);
  }

  return jsonResponse(sendToResponse(send));
}

export async function handleCreateSend(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const typeRaw = getAliasedProp(body, ['type', 'Type']);
  const sendType = parseSendType(typeRaw.value);
  if (sendType === null) {
    return errorResponse('Invalid Send type', 400);
  }
  if (sendType === SendType.File) {
    return errorResponse('File sends should use /api/sends/file/v2', 400);
  }

  const nameRaw = getAliasedProp(body, ['name', 'Name']);
  const keyRaw = getAliasedProp(body, ['key', 'Key']);
  const deletionDateRaw = getAliasedProp(body, ['deletionDate', 'DeletionDate']);
  const textRaw = getAliasedProp(body, ['text', 'Text']);

  if (typeof nameRaw.value !== 'string' || !nameRaw.value.trim()) {
    return errorResponse('Name is required', 400);
  }
  if (typeof keyRaw.value !== 'string' || !keyRaw.value.trim()) {
    return errorResponse('Key is required', 400);
  }

  const deletionDate = parseDate(deletionDateRaw.value);
  if (!deletionDate) {
    return errorResponse('Invalid deletionDate', 400);
  }

  const deletionValidation = validateDeletionDate(deletionDate);
  if (deletionValidation) return deletionValidation;

  const sendData = sanitizeSendData(textRaw.value);
  if (!sendData) {
    return errorResponse('Send data not provided', 400);
  }

  const maxAccessRaw = getAliasedProp(body, ['maxAccessCount', 'MaxAccessCount']);
  const maxAccess = parseMaxAccessCount(maxAccessRaw.value);
  if (!maxAccess.ok) return maxAccess.response;

  const expirationRaw = getAliasedProp(body, ['expirationDate', 'ExpirationDate']);
  const expirationDate = expirationRaw.value === null || expirationRaw.value === undefined
    ? null
    : parseDate(expirationRaw.value);
  if (expirationRaw.value !== null && expirationRaw.value !== undefined && !expirationDate) {
    return errorResponse('Invalid expirationDate', 400);
  }

  const disabledRaw = getAliasedProp(body, ['disabled', 'Disabled']);
  const hideEmailRaw = getAliasedProp(body, ['hideEmail', 'HideEmail']);
  const notesRaw = getAliasedProp(body, ['notes', 'Notes']);
  const passwordRaw = getAliasedProp(body, ['password', 'Password']);
  const authTypeRaw = getAliasedProp(body, ['authType', 'AuthType']);
  const emailsRaw = getAliasedProp(body, ['emails', 'Emails']);

  const requestedAuthType = parseSendAuthType(authTypeRaw.value);
  if (authTypeRaw.present && requestedAuthType === null) {
    return errorResponse('Invalid authType', 400);
  }

  const emailsResult = parseSendEmails(emailsRaw.value);
  if (!emailsResult.ok) return sendEmailListErrorResponse(emailsResult.reason);
  const normalizedEmails = emailsResult.value;
  if (requestedAuthType === SendAuthType.Email && !normalizedEmails) {
    return errorResponse('emails is required for email auth', 400);
  }
  if (normalizedEmails) {
    const mailGate = await requireMailDeliveryForEmailSend(env);
    if (mailGate) return mailGate;
  }

  const now = new Date().toISOString();
  const send: Send = {
    id: generateUUID(),
    userId,
    type: sendType,
    name: nameRaw.value.trim(),
    notes: typeof notesRaw.value === 'string' ? notesRaw.value : null,
    data: JSON.stringify(sendData),
    key: keyRaw.value,
    passwordHash: null,
    passwordSalt: null,
    passwordIterations: null,
    // 名单非空 ⇒ 就是邮箱认证（`authType` 只是展示字段，访问判定看 `emails`）
    authType: normalizedEmails ? SendAuthType.Email : requestedAuthType ?? SendAuthType.None,
    emails: normalizedEmails,
    maxAccessCount: maxAccess.value,
    accessCount: 0,
    disabled: typeof disabledRaw.value === 'boolean' ? disabledRaw.value : false,
    hideEmail: typeof hideEmailRaw.value === 'boolean' ? hideEmailRaw.value : null,
    createdAt: now,
    updatedAt: now,
    expirationDate: expirationDate ? expirationDate.toISOString() : null,
    deletionDate: deletionDate.toISOString(),
  };

  // 邮箱认证优先：不与密码并存（并存会让客户端同时显示密码框）
  if (!normalizedEmails && typeof passwordRaw.value === 'string' && passwordRaw.value.length > 0) {
    await setSendPassword(send, passwordRaw.value);
  } else if (!normalizedEmails && send.authType === SendAuthType.Password) {
    return errorResponse('Password is required for password auth', 400);
  }

  if (send.authType !== SendAuthType.Email) {
    send.emails = null;
  }

  await storage.saveSend(send);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifySendCreateForRequest(request, env, send.id, userId, revisionDate);

  return jsonResponse(sendToResponse(send));
}

export async function handleCreateFileSendV2(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const maxFileSize = getBlobStorageMaxBytes(env, LIMITS.send.maxFileSizeBytes);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const typeRaw = getAliasedProp(body, ['type', 'Type']);
  const sendType = parseSendType(typeRaw.value);
  if (sendType !== SendType.File) {
    return errorResponse('Send content is not a file', 400);
  }

  const fileLengthRaw = getAliasedProp(body, ['fileLength', 'FileLength']);
  const fileLengthParsed = parseFileLength(fileLengthRaw.value);
  if (!fileLengthParsed.ok) return fileLengthParsed.response;
  if (fileLengthParsed.value > maxFileSize) {
    return errorResponse('Send storage limit exceeded with this file', 400);
  }

  const nameRaw = getAliasedProp(body, ['name', 'Name']);
  const keyRaw = getAliasedProp(body, ['key', 'Key']);
  const deletionDateRaw = getAliasedProp(body, ['deletionDate', 'DeletionDate']);
  const fileRaw = getAliasedProp(body, ['file', 'File']);

  if (typeof nameRaw.value !== 'string' || !nameRaw.value.trim()) {
    return errorResponse('Name is required', 400);
  }
  if (typeof keyRaw.value !== 'string' || !keyRaw.value.trim()) {
    return errorResponse('Key is required', 400);
  }

  const deletionDate = parseDate(deletionDateRaw.value);
  if (!deletionDate) {
    return errorResponse('Invalid deletionDate', 400);
  }
  const deletionValidation = validateDeletionDate(deletionDate);
  if (deletionValidation) return deletionValidation;

  const fileData = sanitizeSendData(fileRaw.value);
  if (!fileData) {
    return errorResponse('Send data not provided', 400);
  }

  const fileId = generateUUID();
  fileData.id = fileId;
  fileData.size = fileLengthParsed.value;
  fileData.sizeName = formatSize(fileLengthParsed.value);

  const maxAccessRaw = getAliasedProp(body, ['maxAccessCount', 'MaxAccessCount']);
  const maxAccess = parseMaxAccessCount(maxAccessRaw.value);
  if (!maxAccess.ok) return maxAccess.response;

  const expirationRaw = getAliasedProp(body, ['expirationDate', 'ExpirationDate']);
  const expirationDate = expirationRaw.value === null || expirationRaw.value === undefined
    ? null
    : parseDate(expirationRaw.value);
  if (expirationRaw.value !== null && expirationRaw.value !== undefined && !expirationDate) {
    return errorResponse('Invalid expirationDate', 400);
  }

  const disabledRaw = getAliasedProp(body, ['disabled', 'Disabled']);
  const hideEmailRaw = getAliasedProp(body, ['hideEmail', 'HideEmail']);
  const notesRaw = getAliasedProp(body, ['notes', 'Notes']);
  const passwordRaw = getAliasedProp(body, ['password', 'Password']);
  const authTypeRaw = getAliasedProp(body, ['authType', 'AuthType']);
  const emailsRaw = getAliasedProp(body, ['emails', 'Emails']);

  const requestedAuthType = parseSendAuthType(authTypeRaw.value);
  if (authTypeRaw.present && requestedAuthType === null) {
    return errorResponse('Invalid authType', 400);
  }

  const emailsResult = parseSendEmails(emailsRaw.value);
  if (!emailsResult.ok) return sendEmailListErrorResponse(emailsResult.reason);
  const normalizedEmails = emailsResult.value;
  if (requestedAuthType === SendAuthType.Email && !normalizedEmails) {
    return errorResponse('emails is required for email auth', 400);
  }
  if (normalizedEmails) {
    const mailGate = await requireMailDeliveryForEmailSend(env);
    if (mailGate) return mailGate;
  }

  const now = new Date().toISOString();
  const send: Send = {
    id: generateUUID(),
    userId,
    type: sendType,
    name: nameRaw.value.trim(),
    notes: typeof notesRaw.value === 'string' ? notesRaw.value : null,
    data: JSON.stringify(fileData),
    key: keyRaw.value,
    passwordHash: null,
    passwordSalt: null,
    passwordIterations: null,
    // 名单非空 ⇒ 就是邮箱认证（`authType` 只是展示字段，访问判定看 `emails`）
    authType: normalizedEmails ? SendAuthType.Email : requestedAuthType ?? SendAuthType.None,
    emails: normalizedEmails,
    maxAccessCount: maxAccess.value,
    accessCount: 0,
    disabled: typeof disabledRaw.value === 'boolean' ? disabledRaw.value : false,
    hideEmail: typeof hideEmailRaw.value === 'boolean' ? hideEmailRaw.value : null,
    createdAt: now,
    updatedAt: now,
    expirationDate: expirationDate ? expirationDate.toISOString() : null,
    deletionDate: deletionDate.toISOString(),
  };

  // 邮箱认证优先：不与密码并存（并存会让客户端同时显示密码框）
  if (!normalizedEmails && typeof passwordRaw.value === 'string' && passwordRaw.value.length > 0) {
    await setSendPassword(send, passwordRaw.value);
  } else if (!normalizedEmails && send.authType === SendAuthType.Password) {
    return errorResponse('Password is required for password auth', 400);
  }

  if (send.authType !== SendAuthType.Email) {
    send.emails = null;
  }

  await storage.saveSend(send);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifySendCreateForRequest(request, env, send.id, userId, revisionDate);
  const jwtSecret = getSafeJwtSecret(env);
  if (!jwtSecret) {
    return errorResponse('Server configuration error', 500);
  }
  const uploadToken = await createSendFileUploadToken(userId, send.id, fileId, jwtSecret);

  return jsonResponse({
    fileUploadType: 1,
    object: 'send-fileUpload',
    url: buildDirectUploadUrl(request, `/api/sends/${send.id}/file/${fileId}`, uploadToken),
    sendResponse: sendToResponse(send),
  });
}

export async function handleGetSendFileUpload(
  request: Request,
  env: Env,
  userId: string,
  sendId: string,
  fileId: string
): Promise<Response> {
  void request;
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);
  if (!send || send.userId !== userId) {
    return errorResponse('Send not found', 404);
  }
  if (send.type !== SendType.File) {
    return errorResponse('Send is not a file type send.', 400);
  }

  const sendData = parseStoredSendData(send);
  const expectedFileId = typeof sendData.id === 'string' ? sendData.id : null;
  if (!expectedFileId || expectedFileId !== fileId) {
    return errorResponse('Send file does not match send data.', 400);
  }
  const jwtSecret = getSafeJwtSecret(env);
  if (!jwtSecret) {
    return errorResponse('Server configuration error', 500);
  }
  const uploadToken = await createSendFileUploadToken(userId, send.id, fileId, jwtSecret);

  return jsonResponse({
    fileUploadType: 1,
    object: 'send-fileUpload',
    url: buildDirectUploadUrl(request, `/api/sends/${send.id}/file/${fileId}`, uploadToken),
    sendResponse: sendToResponse(send),
  });
}

export async function handleUploadSendFile(
  request: Request,
  env: Env,
  userId: string,
  sendId: string,
  fileId: string
): Promise<Response> {
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);
  if (!send || send.userId !== userId) {
    return errorResponse('Send not found. Unable to save the file.', 404);
  }
  if (send.type !== SendType.File) {
    return errorResponse('Send is not a file type send.', 400);
  }

  return processSendFileUpload(request, env, send, fileId);
}

export async function handlePublicUploadSendFile(
  request: Request,
  env: Env,
  sendId: string,
  fileId: string
): Promise<Response> {
  const jwtSecret = getSafeJwtSecret(env);
  if (!jwtSecret) {
    return errorResponse('Server configuration error', 500);
  }

  const token = new URL(request.url).searchParams.get('token');
  if (!token) {
    return errorResponse('Token required', 401);
  }

  const claims = await verifySendFileUploadToken(token, jwtSecret);
  if (!claims) {
    return errorResponse('Invalid or expired token', 401);
  }
  if (claims.sendId !== sendId || claims.fileId !== fileId) {
    return errorResponse('Token mismatch', 401);
  }

  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, claims.userId);
  if (!send || send.userId !== claims.userId) {
    return errorResponse('Send not found. Unable to save the file.', 404);
  }
  if (send.type !== SendType.File) {
    return errorResponse('Send is not a file type send.', 400);
  }

  return processSendFileUpload(request, env, send, fileId);
}

export async function handleUpdateSend(request: Request, env: Env, userId: string, sendId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);
  if (!send || send.userId !== userId) {
    return errorResponse('Send not found', 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const typeRaw = getAliasedProp(body, ['type', 'Type']);
  if (typeRaw.present) {
    const incomingType = parseSendType(typeRaw.value);
    if (incomingType === null) {
      return errorResponse('Invalid Send type', 400);
    }
    if (incomingType !== send.type) {
      return errorResponse("Sends can't change type", 400);
    }
  }

  const deletionRaw = getAliasedProp(body, ['deletionDate', 'DeletionDate']);
  if (deletionRaw.present) {
    const deletionDate = parseDate(deletionRaw.value);
    if (!deletionDate) return errorResponse('Invalid deletionDate', 400);
    const deletionValidation = validateDeletionDate(deletionDate);
    if (deletionValidation) return deletionValidation;
    send.deletionDate = deletionDate.toISOString();
  }

  const expirationRaw = getAliasedProp(body, ['expirationDate', 'ExpirationDate']);
  if (expirationRaw.present) {
    if (expirationRaw.value === null || expirationRaw.value === '') {
      send.expirationDate = null;
    } else {
      const expiration = parseDate(expirationRaw.value);
      if (!expiration) return errorResponse('Invalid expirationDate', 400);
      send.expirationDate = expiration.toISOString();
    }
  }

  const nameRaw = getAliasedProp(body, ['name', 'Name']);
  if (nameRaw.present) {
    if (typeof nameRaw.value !== 'string' || !nameRaw.value.trim()) {
      return errorResponse('Name is required', 400);
    }
    send.name = nameRaw.value.trim();
  }

  const keyRaw = getAliasedProp(body, ['key', 'Key']);
  if (keyRaw.present) {
    if (typeof keyRaw.value !== 'string' || !keyRaw.value.trim()) {
      return errorResponse('Key is required', 400);
    }
    send.key = keyRaw.value;
  }

  const notesRaw = getAliasedProp(body, ['notes', 'Notes']);
  if (notesRaw.present) {
    send.notes = typeof notesRaw.value === 'string' ? notesRaw.value : null;
  }

  const disabledRaw = getAliasedProp(body, ['disabled', 'Disabled']);
  if (disabledRaw.present) {
    if (typeof disabledRaw.value !== 'boolean') {
      return errorResponse('Invalid disabled', 400);
    }
    send.disabled = disabledRaw.value;
  }

  const hideEmailRaw = getAliasedProp(body, ['hideEmail', 'HideEmail']);
  if (hideEmailRaw.present) {
    if (hideEmailRaw.value === null) {
      send.hideEmail = null;
    } else if (typeof hideEmailRaw.value === 'boolean') {
      send.hideEmail = hideEmailRaw.value;
    } else {
      return errorResponse('Invalid hideEmail', 400);
    }
  }

  const maxAccessRaw = getAliasedProp(body, ['maxAccessCount', 'MaxAccessCount']);
  if (maxAccessRaw.present) {
    const parsedMax = parseMaxAccessCount(maxAccessRaw.value);
    if (!parsedMax.ok) return parsedMax.response;
    send.maxAccessCount = parsedMax.value;
  }

  if (send.type === SendType.Text) {
    const textRaw = getAliasedProp(body, ['text', 'Text']);
    if (textRaw.present) {
      const textData = sanitizeSendData(textRaw.value);
      if (!textData) {
        return errorResponse('Send data not provided', 400);
      }
      send.data = JSON.stringify(textData);
    }
  }

  const previousAuthType = Number(send.authType);
  const authTypeRaw = getAliasedProp(body, ['authType', 'AuthType']);
  let requestedAuthType: SendAuthType | null = null;
  if (authTypeRaw.present) {
    requestedAuthType = parseSendAuthType(authTypeRaw.value);
    if (requestedAuthType === null) {
      return errorResponse('Invalid authType', 400);
    }
  }

  const emailsRaw = getAliasedProp(body, ['emails', 'Emails']);
  let emailsProvided = false;
  let nextEmails = send.emails;
  if (emailsRaw.present) {
    const emailsResult = parseSendEmails(emailsRaw.value);
    if (!emailsResult.ok) return sendEmailListErrorResponse(emailsResult.reason);
    emailsProvided = true;
    nextEmails = emailsResult.value;
  }

  // 只有「本次真的在设/改邮箱认证」才要求邮件可用 —— 否则邮件临时停用时
  // 连改个名字都做不了（已有的邮箱认证 Send 保持原样）。
  const emailAuthWanted = requestedAuthType === SendAuthType.Email || (emailsProvided && !!nextEmails);
  if (emailAuthWanted) {
    const mailGate = await requireMailDeliveryForEmailSend(env);
    if (mailGate) return mailGate;
  }
  if (requestedAuthType === SendAuthType.Email && !nextEmails) {
    return errorResponse('emails is required for email auth', 400);
  }

  if (nextEmails) {
    send.authType = SendAuthType.Email;
    send.emails = nextEmails;
    // 邮箱认证优先：清掉可能残留的密码
    send.passwordHash = null;
    send.passwordSalt = null;
    send.passwordIterations = null;
  } else {
    send.authType = requestedAuthType ?? (previousAuthType === SendAuthType.Email ? SendAuthType.None : send.authType);
    send.emails = null;
  }
  // 名单被改过 ⇒ 旧码立即作废，否则「已被移出名单的邮箱」还能拿着手上的码打开
  if (emailsProvided) {
    await clearSendOtpsForSend(env.DB, send.id);
  }

  const passwordRaw = getAliasedProp(body, ['password', 'Password']);
  if (!nextEmails && passwordRaw.present && typeof passwordRaw.value === 'string') {
    await setSendPassword(send, passwordRaw.value);
  }

  if (send.authType === SendAuthType.Password && !send.passwordHash) {
    return errorResponse('Password is required for password auth', 400);
  }

  send.updatedAt = new Date().toISOString();
  await storage.saveSend(send);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifySendUpdateForRequest(request, env, send.id, userId, revisionDate);

  return jsonResponse(sendToResponse(send));
}

export async function handleDeleteSend(request: Request, env: Env, userId: string, sendId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);
  if (!send || send.userId !== userId) {
    return errorResponse('Send not found', 404);
  }

  if (send.type === SendType.File) {
    const data = parseStoredSendData(send);
    const fileId = typeof data.id === 'string' ? data.id : null;
    if (fileId) {
      await deleteBlobObject(env, getSendFileObjectKey(send.id, fileId));
    }
  }

  await storage.deleteSend(sendId, userId);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifySendDeleteForRequest(request, env, sendId, userId, revisionDate);
  await writeSendAudit(storage, request, userId, 'send.delete', {
    id: sendId,
    type: send.type,
  });

  return new Response(null, { status: 200 });
}

export async function handleBulkDeleteSends(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  let body: { ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  if (!body.ids || !Array.isArray(body.ids)) {
    return errorResponse('ids array is required', 400);
  }

  const sends = await storage.getSendsByIds(body.ids, userId);
  for (const send of sends) {
    if (send.type !== SendType.File) continue;
    const data = parseStoredSendData(send);
    const fileId = typeof data.id === 'string' ? data.id : null;
    if (fileId) {
      await deleteBlobObject(env, getSendFileObjectKey(send.id, fileId));
    }
  }

  const revisionDate = await storage.bulkDeleteSends(body.ids, userId);
  if (revisionDate) {
    notifyVaultSyncForRequest(request, env, userId, revisionDate);
    for (const send of sends) {
      notifySendDeleteForRequest(request, env, send.id, userId, revisionDate);
    }
    await writeSendAudit(storage, request, userId, 'send.delete.bulk', {
      count: sends.length,
      requestedCount: body.ids.length,
    });
  }

  return new Response(null, { status: 200 });
}

export async function handleRemoveSendPassword(request: Request, env: Env, userId: string, sendId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);
  if (!send || send.userId !== userId) {
    return errorResponse('Send not found', 404);
  }

  await setSendPassword(send, null);
  send.updatedAt = new Date().toISOString();
  await storage.saveSend(send);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifySendUpdateForRequest(request, env, send.id, userId, revisionDate);
  await writeSendAudit(storage, request, userId, 'send.password.remove', {
    id: send.id,
    type: send.type,
  });

  return jsonResponse(sendToResponse(send));
}

export async function handleRemoveSendAuth(request: Request, env: Env, userId: string, sendId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const send = await storage.getSendForUser(sendId, userId);
  if (!send || send.userId !== userId) {
    return errorResponse('Send not found', 404);
  }

  send.authType = SendAuthType.None;
  send.emails = null;
  send.updatedAt = new Date().toISOString();
  await storage.saveSend(send);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifySendUpdateForRequest(request, env, send.id, userId, revisionDate);
  await writeSendAudit(storage, request, userId, 'send.auth.remove', {
    id: send.id,
    type: send.type,
  });

  return jsonResponse(sendToResponse(send));
}

import { base64ToBytes, bytesToBase64, decryptBw, decryptBwFileData, decryptStr, encryptBw, encryptBwFileData, hkdf, pbkdf2 } from '../crypto';
import type { Send, SendDraft, SessionState } from '../types';
import { chunkArray, createApiError, parseErrorMessage, parseJson, uploadDirectEncryptedPayload, type AuthedFetch } from './shared';
import { t } from '../i18n';

function toIsoDateFromDays(value: string, required: boolean): string | null {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw new Error('Deletion days is required');
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (required) throw new Error('Invalid deletion days');
    throw new Error('Invalid expiration days');
  }
  if (!required && n === 0) return null;
  const date = new Date(Date.now() + Math.floor(n) * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const raw = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  return base64ToBytes(padded);
}

const SEND_KEY_SALT = 'bitwarden-send';
const SEND_KEY_PURPOSE = 'send';
const SEND_KEY_SEED_BYTES = 16;
const SEND_PASSWORD_ITERATIONS = 100000;

/**
 * 访问 Send 时的错误类型。与官方服务端逐字一致（见 `src/handlers/sends-shared.ts`），
 * 页面靠它决定该显示密码框、邮箱框还是验证码框。
 */
export type SendAccessErrorType =
  | 'send_id_required'
  | 'send_id_invalid'
  | 'password_hash_b64_required'
  | 'password_hash_b64_invalid'
  | 'email_required'
  | 'email_and_otp_required'
  | 'email_delivery_unavailable';

/** 访问 Send 的凭据。按 Send 的认证方式二选一。 */
export interface PublicSendAccessCredentials {
  password?: string;
  /** 邮箱 OTP：先只给 email（服务端发码），再带上 otp */
  email?: string;
  otp?: string;
}

interface SendAccessError extends Error {
  status?: number;
  sendAccessErrorType?: SendAccessErrorType;
}

/**
 * 读 Send 访问失败的原因。
 *
 * 不能复用 `parseErrorMessage`：它会先读走 body，而这里还要拿 `send_access_error_type`。
 */
async function readSendAccessError(resp: Response, fallback: string): Promise<SendAccessError> {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await resp.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  const description = payload?.error_description ?? payload?.error ?? payload?.Message;
  const error = createApiError(
    typeof description === 'string' && description.trim() ? description : fallback,
    resp.status
  ) as SendAccessError;
  const errorType = payload?.send_access_error_type;
  if (typeof errorType === 'string') error.sendAccessErrorType = errorType as SendAccessErrorType;
  return error;
}

/** 认证方式（与服务端 `SendAuthType` 对齐） */
const SEND_AUTH_EMAIL = 0;
const SEND_AUTH_PASSWORD = 1;
const SEND_AUTH_NONE = 2;

/**
 * 把草稿里的访问设置转成请求字段。
 *
 * ⚠️ 邮箱认证与密码**互斥**：服务端在名单非空时会清掉密码，所以前端也不该两个都发
 * （编辑中用密码的 Send 改成邮箱时，草稿里可能还留着旧密码文本）。
 */
function sendAccessPayload(draft: SendDraft): { authType: number; emails: string | null; password: string | null } {
  const emails = draft.accessMode === 'emails' ? String(draft.emails || '').trim() : '';
  if (emails) return { authType: SEND_AUTH_EMAIL, emails, password: null };
  const password = draft.accessMode === 'password' ? String(draft.password || '') : '';
  return { authType: password ? SEND_AUTH_PASSWORD : SEND_AUTH_NONE, emails: null, password };
}

async function encryptTextValue(value: string, enc: Uint8Array, mac: Uint8Array): Promise<string | null> {
  const s = String(value || '');
  if (!s.trim()) return null;
  return encryptBw(new TextEncoder().encode(s), enc, mac);
}

async function toSendKeyParts(sendKeyMaterial: Uint8Array): Promise<{ enc: Uint8Array; mac: Uint8Array }> {
  if (sendKeyMaterial.length >= 64) {
    return { enc: sendKeyMaterial.slice(0, 32), mac: sendKeyMaterial.slice(32, 64) };
  }
  const derived = await hkdf(sendKeyMaterial, SEND_KEY_SALT, SEND_KEY_PURPOSE, 64);
  return { enc: derived.slice(0, 32), mac: derived.slice(32, 64) };
}

async function hashSendPasswordB64(password: string, sendKeyMaterial: Uint8Array): Promise<string> {
  const hash = await pbkdf2(password, sendKeyMaterial, SEND_PASSWORD_ITERATIONS, 32);
  return bytesToBase64(hash);
}

function parseMaxAccessCountRaw(value: string): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid max access count');
  return Math.floor(n);
}

export async function getSends(authedFetch: AuthedFetch): Promise<Send[]> {
  const resp = await authedFetch('/api/sends');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_load_failed')));
  const body = await parseJson<{ data?: Send[] }>(resp);
  return body?.data || [];
}

export async function getSendById(authedFetch: AuthedFetch, sendId: string): Promise<Send> {
  const id = String(sendId || '').trim();
  if (!id) throw new Error('Send id is required');
  const resp = await authedFetch(`/api/sends/${encodeURIComponent(id)}`);
  if (resp.status === 404) throw createApiError('Send not found', 404);
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, 'Load send failed'));
  const body = await parseJson<Send>(resp);
  if (!body?.id) throw new Error('Load send failed');
  return body;
}

export async function createSend(
  authedFetch: AuthedFetch,
  session: SessionState,
  draft: SendDraft,
  onProgress?: (percent: number | null) => void
): Promise<Send> {
  if (!session.symEncKey || !session.symMacKey) throw new Error('Vault key unavailable');
  const userEnc = base64ToBytes(session.symEncKey);
  const userMac = base64ToBytes(session.symMacKey);
  const sendKeyMaterial = crypto.getRandomValues(new Uint8Array(SEND_KEY_SEED_BYTES));
  const sendKeyForUser = await encryptBw(sendKeyMaterial, userEnc, userMac);
  const sendKey = await toSendKeyParts(sendKeyMaterial);
  const nameCipher = await encryptTextValue(draft.name || '', sendKey.enc, sendKey.mac);
  const notesCipher = await encryptTextValue(draft.notes || '', sendKey.enc, sendKey.mac);

  const deletionIso = toIsoDateFromDays(draft.deletionDays, true)!;
  const expirationIso = toIsoDateFromDays(draft.expirationDays, false);
  const maxAccessCount = parseMaxAccessCountRaw(draft.maxAccessCount);
  const access = sendAccessPayload(draft);
  const passwordHash = access.password ? await hashSendPasswordB64(access.password, sendKeyMaterial) : null;

  if (draft.type === 'text') {
    const text = String(draft.text || '').trim();
    if (!text) throw new Error('Send text is required');
    const textCipher = await encryptTextValue(text, sendKey.enc, sendKey.mac);

    const payload = {
      type: 0,
      name: nameCipher,
      notes: notesCipher,
      key: sendKeyForUser,
      text: {
        text: textCipher,
        hidden: false,
      },
      maxAccessCount,
      password: passwordHash,
      emails: access.emails,
      authType: access.authType,
      hideEmail: false,
      disabled: !!draft.disabled,
      deletionDate: deletionIso,
      expirationDate: expirationIso,
    };

    const resp = await authedFetch('/api/sends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(await parseErrorMessage(resp, 'Create send failed'));
    const body = await parseJson<Send>(resp);
    if (!body?.id) throw new Error('Create send failed');
    return body;
  }

  if (!draft.file) throw new Error('File is required');
  const fileNameCipher = await encryptTextValue(draft.file.name, sendKey.enc, sendKey.mac);
  if (!fileNameCipher) throw new Error('Invalid file name');
  const plainFileBytes = new Uint8Array(await draft.file.arrayBuffer());
  const encryptedFileBytes = await encryptBwFileData(plainFileBytes, sendKey.enc, sendKey.mac);

  const fileResp = await authedFetch('/api/sends/file/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 1,
      name: nameCipher,
      notes: notesCipher,
      key: sendKeyForUser,
      file: {
        fileName: fileNameCipher,
      },
      fileLength: encryptedFileBytes.byteLength,
      maxAccessCount,
      password: passwordHash,
      emails: access.emails,
      authType: access.authType,
      hideEmail: false,
      disabled: !!draft.disabled,
      deletionDate: deletionIso,
      expirationDate: expirationIso,
    }),
  });
  if (!fileResp.ok) throw new Error(await parseErrorMessage(fileResp, 'Create file send failed'));

  const uploadInfo = await parseJson<{ url?: string; sendResponse?: Send; fileUploadType?: number }>(fileResp);
  const uploadUrl = uploadInfo?.url;
  if (!uploadUrl) throw new Error('Create file send failed: missing upload URL');
  if (!session.accessToken) throw new Error('Unauthorized');
  const payload = new ArrayBuffer(encryptedFileBytes.byteLength);
  new Uint8Array(payload).set(encryptedFileBytes);
  const uploadResp = await uploadDirectEncryptedPayload({
    accessToken: session.accessToken,
    uploadUrl,
    payload,
    fileUploadType: uploadInfo?.fileUploadType,
    unsupportedMessage: 'Unsupported send upload type',
    onProgress,
  });
  if (!uploadResp.ok) throw new Error(await parseErrorMessage(uploadResp, 'Upload send file failed'));
  if (!uploadInfo?.sendResponse?.id) throw new Error('Create file send failed');
  return uploadInfo.sendResponse;
}

export async function updateSend(
  authedFetch: AuthedFetch,
  session: SessionState,
  send: Send,
  draft: SendDraft
): Promise<Send> {
  if (!session.symEncKey || !session.symMacKey) throw new Error('Vault key unavailable');
  if (!send.key) throw new Error('Send key unavailable');
  const userEnc = base64ToBytes(session.symEncKey);
  const userMac = base64ToBytes(session.symMacKey);
  const sendKeyMaterial = await decryptBw(send.key, userEnc, userMac);
  const sendKey = await toSendKeyParts(sendKeyMaterial);
  const nameCipher = await encryptTextValue(draft.name || '', sendKey.enc, sendKey.mac);
  const notesCipher = await encryptTextValue(draft.notes || '', sendKey.enc, sendKey.mac);

  const deletionIso = toIsoDateFromDays(draft.deletionDays, true)!;
  const expirationIso = toIsoDateFromDays(draft.expirationDays, false);
  const maxAccessCount = parseMaxAccessCountRaw(draft.maxAccessCount);

  if (draft.type === 'file' && draft.file) {
    throw new Error('Updating file content is not supported yet');
  }

  const textCipher = await encryptTextValue(String(draft.text || ''), sendKey.enc, sendKey.mac);

  const access = sendAccessPayload(draft);
  const passwordHash = access.password ? await hashSendPasswordB64(access.password, sendKeyMaterial) : null;

  const payload = {
    id: send.id,
    type: draft.type === 'file' ? 1 : 0,
    name: nameCipher,
    notes: notesCipher,
    key: send.key,
    text: {
      text: textCipher,
      hidden: false,
    },
    maxAccessCount,
    password: passwordHash,
    emails: access.emails,
    authType: access.authType,
    hideEmail: false,
    disabled: !!draft.disabled,
    deletionDate: deletionIso,
    expirationDate: expirationIso,
  };

  const resp = await authedFetch(`/api/sends/${encodeURIComponent(send.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, 'Update send failed'));
  const body = await parseJson<Send>(resp);
  if (!body?.id) throw new Error('Update send failed');
  return body;
}

export async function deleteSend(authedFetch: AuthedFetch, sendId: string): Promise<void> {
  const resp = await authedFetch(`/api/sends/${encodeURIComponent(sendId)}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, 'Delete send failed'));
}

export async function bulkDeleteSends(authedFetch: AuthedFetch, ids: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
  for (const chunk of chunkArray(uniqueIds, 200)) {
    const resp = await authedFetch('/api/sends/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: chunk }),
    });
    if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_bulk_delete_sends_failed')));
  }
}

/**
 * 用 `send_id` + 凭据换访问令牌（官方客户端同款：`grant_type=send_access`，表单编码）。
 * ⚠️ **必须两步走**：验证码是一次性的，拿到令牌后再取数据 / 下载文件都不能重新提交验证码。
 */
export async function requestSendAccessToken(
  accessId: string,
  keyPart?: string | null,
  credentials: PublicSendAccessCredentials = {},
  options?: { signal?: AbortSignal }
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'send_access',
    // SDK 固定值：服务端目前不校验，但保持一致便于排查
    client_id: 'send',
    scope: 'api.send',
    send_id: accessId,
  });
  const email = String(credentials.email || '').trim();
  if (email) form.set('email', email);
  const otp = String(credentials.otp || '').trim();
  if (otp) form.set('otp', otp);

  const plainPassword = String(credentials.password || '').trim();
  if (plainPassword && keyPart) {
    try {
      const passwordHashB64 = await hashSendPasswordB64(plainPassword, base64UrlToBytes(keyPart));
      form.set('password_hash_b64', passwordHashB64);
    } catch {
      // 密钥材料不合法：不提交密码，服务端会按「缺凭据」拒绝
    }
  }

  const resp = await fetch('/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: options?.signal,
  });
  if (!resp.ok) {
    throw await readSendAccessError(resp, 'Failed to access send');
  }
  const body = await parseJson<{ access_token?: string }>(resp);
  if (!body?.access_token) throw new Error('Failed to access send');
  return body.access_token;
}

/** 用访问令牌取 Send 内容（`POST /api/sends/access`）。 */
export async function accessSendWithToken(accessToken: string): Promise<unknown> {
  const resp = await fetch('/api/sends/access', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw await readSendAccessError(resp, 'Failed to access send');
  }
  return (await parseJson<unknown>(resp)) || null;
}

/** 用访问令牌取文件下载地址（`POST /api/sends/access/file/{fileId}`）。 */
export async function requestSendFileUrl(accessToken: string, fileId: string): Promise<string> {
  const resp = await fetch(`/api/sends/access/file/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw await readSendAccessError(resp, 'Failed to access send file');
  }
  const body = await parseJson<{ url?: string }>(resp);
  if (!body?.url) throw new Error('Missing file URL');
  return body.url;
}

export async function decryptPublicSend(accessData: unknown, urlSafeKey: string): Promise<unknown> {
  const sendKeyMaterial = base64UrlToBytes(urlSafeKey);
  const sendKey = await toSendKeyParts(sendKeyMaterial);
  const source = accessData && typeof accessData === 'object' ? accessData as Record<string, unknown> : {};
  const text = source.text && typeof source.text === 'object' ? source.text as Record<string, unknown> : null;
  const file = source.file && typeof source.file === 'object' ? source.file as Record<string, unknown> : null;
  const out: Record<string, unknown> = { ...source };
  out.decName = await decryptStr(String(source.name || ''), sendKey.enc, sendKey.mac);
  if (text?.text) {
    out.decText = await decryptStr(String(text.text), sendKey.enc, sendKey.mac);
  }
  if (file?.fileName) {
    try {
      out.decFileName = await decryptStr(String(file.fileName), sendKey.enc, sendKey.mac);
    } catch {
      out.decFileName = String(file.fileName);
    }
  }
  return out;
}

export async function decryptPublicSendFileBytes(
  encryptedBytes: ArrayBuffer | Uint8Array,
  urlSafeKey: string
): Promise<Uint8Array> {
  const sendKeyMaterial = base64UrlToBytes(urlSafeKey);
  const sendKey = await toSendKeyParts(sendKeyMaterial);
  const encrypted = encryptedBytes instanceof Uint8Array ? encryptedBytes : new Uint8Array(encryptedBytes);
  return decryptBwFileData(encrypted, sendKey.enc, sendKey.mac);
}

export function buildSendShareKey(sendKeyEncrypted: string, userEncB64: string, userMacB64: string): Promise<string> {
  const userEnc = base64ToBytes(userEncB64);
  const userMac = base64ToBytes(userMacB64);
  return decryptBw(sendKeyEncrypted, userEnc, userMac).then((keyMaterial) => bytesToBase64Url(keyMaterial));
}

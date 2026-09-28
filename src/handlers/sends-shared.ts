import { Env, Send, SendAuthType, SendResponse, SendType } from '../types';
import {
  notifyUserSendCreate,
  notifyUserSendDelete,
  notifyUserSendUpdate,
  notifyUserVaultSync,
} from '../durable/notifications-hub';
import { StorageService } from '../services/storage';
import { jsonResponse, errorResponse } from '../utils/response';
import { readActingDeviceIdentifier } from '../utils/device';
import { LIMITS } from '../config/limits';
import { isMailDeliveryAvailableSoft, resolveMailConnection, resolveMailRenderPreferences } from '../services/mail-settings';
import { renderSendOtpEmail } from '../services/mail';
import { sendSmtpMail } from '../services/smtp-client';
import { safeWriteAuditEvent } from '../services/audit-events';
import {
  checkSendOtpQuota,
  issueSendOtp,
  normalizeSendOtpEmail,
  verifySendOtp,
} from '../services/send-email-otp';

export const SEND_INACCESSIBLE_MSG = 'Send does not exist or is no longer available';
const SEND_PASSWORD_ITERATIONS = 100_000;
export const SEND_PASSWORD_LIMIT_SCOPE = 'send-password';

export function notifyVaultSyncForRequest(
  request: Request,
  env: Env,
  userId: string,
  revisionDate: string
): void {
  notifyUserVaultSync(env, userId, revisionDate, readActingDeviceIdentifier(request));
}

export function notifySendCreateForRequest(
  request: Request,
  env: Env,
  sendId: string,
  userId: string,
  revisionDate: string
): void {
  notifyUserSendCreate(env, {
    userId,
    sendId,
    revisionDate,
    contextId: readActingDeviceIdentifier(request),
  });
}

export function notifySendUpdateForRequest(
  request: Request,
  env: Env,
  sendId: string,
  userId: string,
  revisionDate: string
): void {
  notifyUserSendUpdate(env, {
    userId,
    sendId,
    revisionDate,
    contextId: readActingDeviceIdentifier(request),
  });
}

export function notifySendDeleteForRequest(
  request: Request,
  env: Env,
  sendId: string,
  userId: string,
  revisionDate: string
): void {
  notifyUserSendDelete(env, {
    userId,
    sendId,
    revisionDate,
    contextId: readActingDeviceIdentifier(request),
  });
}

export function getAliasedProp(source: unknown, aliases: string[]): { present: boolean; value: unknown } {
  if (!source || typeof source !== 'object') return { present: false, value: undefined };
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = (source as Record<string, unknown>)[key];
      return { present: true, value };
    }
  }
  return { present: false, value: undefined };
}

export function base64UrlEncode(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array | null {
  try {
    let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    const raw = atob(normalized);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function uuidToBytes(uuid: string): Uint8Array | null {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function toAccessId(sendId: string): string {
  const bytes = uuidToBytes(sendId);
  if (!bytes) return '';
  return base64UrlEncode(bytes);
}

export function fromAccessId(accessId: string): string | null {
  const bytes = base64UrlDecode(accessId);
  if (!bytes || bytes.length !== 16) return null;
  return bytesToUuid(bytes);
}

function isLikelyUuid(value: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(value);
}

export async function resolveSendFromIdOrAccessId(storage: StorageService, idOrAccessId: string): Promise<Send | null> {
  if (isLikelyUuid(idOrAccessId)) {
    const send = await storage.getSend(idOrAccessId);
    if (send) return send;
  }

  const sendId = fromAccessId(idOrAccessId);
  if (!sendId) return null;
  return storage.getSend(sendId);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function parseDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value = raw.trim();
  if (!/[zZ]$/.test(value) && !/[+\-]\d{2}:?\d{2}$/.test(value)) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      value += 'Z';
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) {
      value = value.replace(' ', 'T') + 'Z';
    }
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function parseInteger(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

export function sanitizeSendData(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = { ...(raw as Record<string, unknown>) };
  delete data.response;
  return data;
}

export function parseStoredSendData(send: Send): Record<string, unknown> {
  try {
    const parsed = JSON.parse(send.data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return {};
  } catch {
    return {};
  }
}

function normalizeSendDataSizeField(data: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...data };
  if (typeof normalized.size === 'number' && Number.isFinite(normalized.size)) {
    normalized.size = String(Math.trunc(normalized.size));
  }
  return normalized;
}

export function isSendAvailable(send: Send): boolean {
  const now = Date.now();

  if (send.maxAccessCount !== null && send.accessCount >= send.maxAccessCount) {
    return false;
  }

  if (send.expirationDate) {
    const expirationMs = new Date(send.expirationDate).getTime();
    if (!Number.isNaN(expirationMs) && now >= expirationMs) {
      return false;
    }
  }

  const deletionMs = new Date(send.deletionDate).getTime();
  if (!Number.isNaN(deletionMs) && now >= deletionMs) {
    return false;
  }

  if (send.disabled) {
    return false;
  }

  return true;
}

async function deriveSendPasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    key,
    256
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function isLikelyHashB64(value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(raw)) return false;
  const decoded = base64UrlDecode(raw);
  return !!decoded && decoded.length === 32;
}

export async function setSendPassword(send: Send, password: string | null): Promise<void> {
  if (!password) {
    send.passwordHash = null;
    send.passwordSalt = null;
    send.passwordIterations = null;
    if (send.authType === SendAuthType.Password) {
      send.authType = SendAuthType.None;
    }
    return;
  }

  if (isLikelyHashB64(password)) {
    send.passwordHash = password.trim();
    send.passwordSalt = null;
    send.passwordIterations = null;
    send.authType = SendAuthType.Password;
    return;
  }

  const salt = crypto.getRandomValues(new Uint8Array(64));
  const hash = await deriveSendPasswordHash(password, salt, SEND_PASSWORD_ITERATIONS);

  send.passwordSalt = base64UrlEncode(salt);
  send.passwordHash = base64UrlEncode(hash);
  send.passwordIterations = SEND_PASSWORD_ITERATIONS;
  send.authType = SendAuthType.Password;
}

export async function verifySendPassword(send: Send, password: string): Promise<boolean> {
  if (!send.passwordHash) {
    return false;
  }

  if (!send.passwordSalt || !send.passwordIterations) {
    return verifySendPasswordHashB64(send, password);
  }

  const salt = base64UrlDecode(send.passwordSalt);
  const expected = base64UrlDecode(send.passwordHash);
  if (!salt || !expected) return false;

  const actual = await deriveSendPasswordHash(password, salt, send.passwordIterations);
  return constantTimeEqual(actual, expected);
}

export function verifySendPasswordHashB64(send: Send, passwordHashB64: string): boolean {
  if (!send.passwordHash || !passwordHashB64) return false;
  const expected = base64UrlDecode(send.passwordHash);
  const provided = base64UrlDecode(passwordHashB64);
  if (!expected || !provided) return false;
  return constantTimeEqual(expected, provided);
}

export function validateDeletionDate(date: Date): Response | null {
  const maxMs = Date.now() + LIMITS.send.maxDeletionDays * 24 * 60 * 60 * 1000;
  if (date.getTime() > maxMs) {
    return errorResponse(
      'You cannot have a Send with a deletion date that far into the future. Adjust the Deletion Date to a value less than 31 days from now and try again.',
      400
    );
  }
  return null;
}

export function parseMaxAccessCount(value: unknown): { ok: true; value: number | null } | { ok: false; response: Response } {
  const parsed = parseInteger(value);
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null };
  }
  if (parsed === null || parsed < 0) {
    return { ok: false, response: errorResponse('Invalid maxAccessCount', 400) };
  }
  return { ok: true, value: parsed };
}

export function parseFileLength(value: unknown): { ok: true; value: number } | { ok: false; response: Response } {
  const parsed = parseInteger(value);
  if (parsed === null) {
    return { ok: false, response: errorResponse('Invalid send length', 400) };
  }
  if (parsed < 0) {
    return { ok: false, response: errorResponse("Send size can't be negative", 400) };
  }
  return { ok: true, value: parsed };
}

export function parseSendType(value: unknown): SendType | null {
  const type = parseInteger(value);
  if (type === SendType.Text || type === SendType.File) return type;
  return null;
}

export function parseSendAuthType(value: unknown): SendAuthType | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInteger(value);
  if (parsed === SendAuthType.Email || parsed === SendAuthType.Password || parsed === SendAuthType.None) {
    return parsed;
  }
  return null;
}

export const SEND_EMAIL_LIST_MAX = 20;
const SEND_EMAIL_MAX_LENGTH = 254;
const SEND_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type SendEmailListResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'invalid' | 'too-many' };

/**
 * 把请求里的 `emails` 规范成存储格式（小写、逗号分隔、去重）。
 * ⚠️ 不合法项与超限**明确报错**，不静默丢弃 —— 用户以为名单生效了比直接报错糟得多。
 */
export function parseSendEmails(value: unknown): SendEmailListResult {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const raw = Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => String(item)).join(',')
    : typeof value === 'string'
      ? value
      : null;
  if (raw === null) return { ok: false, reason: 'invalid' };

  const items = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (items.length === 0) return { ok: true, value: null };
  if (items.length > SEND_EMAIL_LIST_MAX) return { ok: false, reason: 'too-many' };
  if (items.some((item) => item.length > SEND_EMAIL_MAX_LENGTH || !SEND_EMAIL_PATTERN.test(item))) {
    return { ok: false, reason: 'invalid' };
  }
  // 小写化后去重：`A@b.com` 与 `a@b.com` 是同一个收件人
  return { ok: true, value: Array.from(new Set(items)).join(',') };
}

/** 读 Send 的邮箱名单（已存为小写逗号串），返回数组。 */
function sendEmailList(send: Send): string[] {
  if (typeof send.emails !== 'string') return [];
  return send.emails.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/**
 * ⚠️ 判据是 `emails` / `passwordHash` 是否非 null，**不是 `authType`**（官方同款）：
 * `authType` 只是展示字段；拿它判定会把「authType=Email 但名单为空」的 Send 放行给匿名。
 */
type SendAuthMethod = 'inaccessible' | 'none' | 'password' | 'email';

export function resolveSendAuthMethod(send: Send): SendAuthMethod {
  if (!isSendAvailable(send)) return 'inaccessible';
  if (send.emails !== null && send.emails !== undefined) return 'email';
  if (send.passwordHash) return 'password';
  return 'none';
}

export function getSafeJwtSecret(env: Env): { ok: true; secret: string } | { ok: false; response: Response } {
  const secret = (env.JWT_SECRET || '').trim();
  if (!secret || secret.length < LIMITS.auth.jwtSecretMinLength) {
    return { ok: false, response: errorResponse('Server configuration error', 500) };
  }
  return { ok: true, secret };
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function sendToResponse(send: Send): SendResponse {
  const data = normalizeSendDataSizeField(parseStoredSendData(send));
  return {
    id: send.id,
    accessId: toAccessId(send.id),
    type: Number(send.type) || 0,
    name: send.name,
    notes: send.notes,
    text: send.type === SendType.Text ? data : null,
    file: send.type === SendType.File ? data : null,
    key: send.key,
    maxAccessCount: send.maxAccessCount,
    accessCount: send.accessCount,
    password: send.passwordHash,
    emails: send.emails,
    authType: send.authType,
    disabled: send.disabled,
    hideEmail: send.hideEmail,
    revisionDate: send.updatedAt,
    expirationDate: send.expirationDate,
    deletionDate: send.deletionDate,
    object: 'send',
  };
}

export function sendToAccessResponse(send: Send, creatorIdentifier: string | null): Record<string, unknown> {
  const data = normalizeSendDataSizeField(parseStoredSendData(send));
  return {
    id: send.id,
    type: Number(send.type) || 0,
    name: send.name,
    text: send.type === SendType.Text ? data : null,
    file: send.type === SendType.File ? data : null,
    expirationDate: send.expirationDate,
    deletionDate: send.deletionDate,
    creatorIdentifier,
    object: 'send-access',
  };
}

export async function getCreatorIdentifier(storage: StorageService, send: Send): Promise<string | null> {
  if (send.hideEmail) return null;
  const owner = await storage.getUserById(send.userId);
  return owner?.email ?? null;
}

type PublicSendAccessValidationResult =
  | { ok: true }
  | { ok: false; response: Response; reason: SendAccessErrorType };

/**
 * send access 的错误码。**必须与官方逐字一致**：官方客户端靠它决定显示「邮箱框」还是
 * 「验证码框」（`get-send-access-token-error.type.ts`）。
 *
 * ⭐ 防枚举：`email_and_otp_required` 同时用于「邮箱不在名单」「已发码」「码错了」，
 * 且描述文案逐字相同 —— 否则「是否在名单里」就能被探知。
 */
export type SendAccessErrorType =
  | 'send_id_required'
  | 'send_id_invalid'
  | 'password_hash_b64_required'
  | 'password_hash_b64_invalid'
  | 'email_required'
  | 'email_and_otp_required'
  | 'email_delivery_unavailable';

const SEND_ACCESS_ERROR_DESCRIPTIONS: Record<SendAccessErrorType, string> = {
  send_id_required: 'send_id is required.',
  send_id_invalid: 'send_id is invalid.',
  password_hash_b64_required: 'password_hash_b64 is required.',
  password_hash_b64_invalid: 'password_hash_b64 is invalid.',
  email_required: 'email is required.',
  email_and_otp_required: 'email and otp are required.',
  email_delivery_unavailable: 'Email delivery is not configured on this server.',
};

/** 状态码：官方对 invalid_request / invalid_grant 都回 400；发不出邮件（自加，与名单无关）回 503。 */
export function sendAccessErrorStatus(type: SendAccessErrorType): number {
  return type === 'email_delivery_unavailable' ? 503 : 400;
}

export function sendAccessErrorBody(type: SendAccessErrorType): Record<string, unknown> {
  const description = SEND_ACCESS_ERROR_DESCRIPTIONS[type];
  return {
    error: type === 'send_id_invalid' ? 'invalid_grant' : 'invalid_request',
    error_description: description,
    send_access_error_type: type,
    // 顶层 `Message` 供官方客户端读文案；`ErrorModel` 供 identity 风格的调用方
    Message: description,
    ErrorModel: { Message: description, Object: 'error' },
  };
}

export function sendAccessErrorResponse(
  type: SendAccessErrorType,
  status: number = sendAccessErrorStatus(type)
): Response {
  return jsonResponse(sendAccessErrorBody(type), status);
}

export function sendPasswordLimitKey(clientIdentifier: string, sendId: string): string {
  return `${clientIdentifier}:${SEND_PASSWORD_LIMIT_SCOPE}:${String(sendId || '').trim() || 'unknown-send'}`;
}

function sendPasswordLockMessage(retryAfterSeconds: number): string {
  return `Too many failed send password attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`;
}

export function sendPasswordLockedErrorResponse(retryAfterSeconds: number): Response {
  return errorResponse(sendPasswordLockMessage(retryAfterSeconds), 429);
}

export function sendPasswordLockedOAuthResponse(retryAfterSeconds: number): Response {
  const message = sendPasswordLockMessage(retryAfterSeconds);
  return jsonResponse(
    {
      error: 'invalid_grant',
      error_description: message,
      send_access_error_type: 'too_many_password_attempts',
      ErrorModel: {
        Message: message,
        Object: 'error',
      },
    },
    429
  );
}

/**
 * 邮箱 OTP 访问：判定本次请求能否放行。
 * ⚠️ 返回的错误类型必须原样透出 ——「名单外邮箱」「已发码」「码错了」必须给出逐字相同的响应。
 */
export async function resolveSendEmailOtpAccess(
  env: Env,
  send: Send,
  emailRaw: unknown,
  otpRaw: unknown
): Promise<{ ok: true } | { ok: false; errorType: SendAccessErrorType }> {
  const email = normalizeSendOtpEmail(emailRaw);
  if (!email) return { ok: false, errorType: 'email_required' };

  // 服务器整体发不出信 ⇒ 对**所有人**都一样（与名单无关）⇒ 可以明确报错。
  // 反之，任何「与名单相关」的差异都只能伪装成 email_and_otp_required（见下）。
  if (!(await isMailDeliveryAvailableSoft(env))) {
    return { ok: false, errorType: 'email_delivery_unavailable' };
  }

  // 先查限流再查名单：顺序反了的话，「被限流」本身就成了「这个邮箱在名单里」的证据。
  const quota = await checkSendOtpQuota(env.DB, send.id, email, send.userId);
  if (!sendEmailList(send).includes(email)) {
    return { ok: false, errorType: 'email_and_otp_required' };
  }

  const otp = String(otpRaw ?? '').trim();
  if (!otp) {
    // 限流命中时**静默不发信**，但响应与「已发码」完全一致。
    if (!quota.allowed) return { ok: false, errorType: 'email_and_otp_required' };
    const issued = await issueSendOtp(env.DB, send.id, email, send.userId, env.JWT_SECRET);
    await deliverSendOtpMail(env, send, email, issued);
    return { ok: false, errorType: 'email_and_otp_required' };
  }

  const outcome = await verifySendOtp(env.DB, send.id, email, otp, env.JWT_SECRET);
  if (outcome !== 'ok') return { ok: false, errorType: 'email_and_otp_required' };
  return { ok: true };
}

/**
 * 发出 Send 验证码。失败只写审计、不影响响应 —— 响应必须与「已发码」一致，
 * 否则「信发出去了没有」就能用来枚举名单。
 */
async function deliverSendOtpMail(
  env: Env,
  send: Send,
  email: string,
  issued: { code: string; expiresAt: string }
): Promise<void> {
  const connection = await resolveMailConnection(env.DB, env);
  if (connection.status !== 'ok') return;

  // 语言/时区取 **Send 所有者**的偏好：收件人往往是外部邮箱，我们没有他的偏好。
  // 也因此刻意不传 `preferencesUnset` —— 「未设定时区」那句提示是给账号主人看的，
  // 出现在陌生收件人的收件箱里只会让人困惑。
  const storage = new StorageService(env.DB);
  const owner = await storage.getUserById(send.userId);
  const preferences = resolveMailRenderPreferences(owner ?? {});
  const mail = renderSendOtpEmail(
    { code: issued.code, expiresAt: new Date(issued.expiresAt) },
    { locale: preferences.locale, timezone: preferences.timezone }
  );

  try {
    await sendSmtpMail(connection.settings, {
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch {
    await safeWriteAuditEvent(env, {
      actorUserId: send.userId,
      action: 'send.otp.send_failed',
      category: 'system',
      level: 'warn',
      targetType: 'send',
      targetId: send.id,
      metadata: { email },
    });
  }
}

/**
 * v1 访问路径（`POST /api/sends/access/{accessId}`，官方客户端在用）。
 * 密码分支沿用历史状态码（缺密码 401），只补上 `send_access_error_type`。
 */
export async function validatePublicSendAccess(
  env: Env,
  send: Send,
  body: unknown
): Promise<PublicSendAccessValidationResult> {
  const method = resolveSendAuthMethod(send);

  if (method === 'email') {
    const result = await resolveSendEmailOtpAccess(
      env,
      send,
      getAliasedProp(body, ['email', 'Email']).value,
      getAliasedProp(body, ['otp', 'Otp']).value
    );
    if (result.ok) return { ok: true };
    return { ok: false, response: sendAccessErrorResponse(result.errorType), reason: result.errorType };
  }

  if (method !== 'password') return { ok: true };

  const passwordRaw = getAliasedProp(body, ['password', 'Password']);
  const passwordHashB64Raw = getAliasedProp(body, [
    'password_hash_b64',
    'passwordHashB64',
    'passwordHash',
    'password_hash',
  ]);

  let validPassword = false;
  if (send.passwordSalt && send.passwordIterations) {
    if (typeof passwordRaw.value !== 'string') {
      return {
        ok: false,
        response: sendAccessErrorResponse('password_hash_b64_required', 401),
        reason: 'password_hash_b64_required',
      };
    }
    validPassword = await verifySendPassword(send, passwordRaw.value);
  } else {
    const candidate =
      typeof passwordHashB64Raw.value === 'string'
        ? passwordHashB64Raw.value
        : typeof passwordRaw.value === 'string'
          ? passwordRaw.value
          : '';
    if (!candidate) {
      return {
        ok: false,
        response: sendAccessErrorResponse('password_hash_b64_required', 401),
        reason: 'password_hash_b64_required',
      };
    }
    validPassword = verifySendPasswordHashB64(send, candidate);
  }
  if (!validPassword) {
    return {
      ok: false,
      response: sendAccessErrorResponse('password_hash_b64_invalid'),
      reason: 'password_hash_b64_invalid',
    };
  }

  return { ok: true };
}

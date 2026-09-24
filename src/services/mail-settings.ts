/**
 * 邮件发送（SMTP）的全局配置与凭据存储。
 *
 * config 键（前缀沿用 `globalSettings__` 风格）：
 * `globalSettings__mail__enabled` / `__host` / `__port` / `__encryption` / `__username` /
 * `__fromAddress` / `__fromName`，以及 **加密信封** `__secret`（内含口令）。
 *
 * 口令单独放进信封：config 会随备份导出，明文落库等于把凭据写进每个归档。
 * 不做 isolate 内缓存：发信低频，缓存反而引出「改完配置本 isolate 不生效」这类问题。
 */
import type { Env } from '../types';
import { isValidTimeZone } from '../utils/timezone';
import { getConfigValue } from './storage-config-repo';
import { decryptDomainValue, deriveServerDomainKey, encryptDomainValue } from './server-secret-crypto';
import { DEFAULT_MAIL_LOCALE, DEFAULT_MAIL_TIMEZONE, matchMailLocale } from './mail';
import type { SmtpConnectionSettings, SmtpEncryption } from './smtp-client';

export const MAIL_ENABLED_CONFIG_KEY = 'globalSettings__mail__enabled';
export const MAIL_HOST_CONFIG_KEY = 'globalSettings__mail__host';
export const MAIL_PORT_CONFIG_KEY = 'globalSettings__mail__port';
export const MAIL_ENCRYPTION_CONFIG_KEY = 'globalSettings__mail__encryption';
export const MAIL_USERNAME_CONFIG_KEY = 'globalSettings__mail__username';
export const MAIL_FROM_ADDRESS_CONFIG_KEY = 'globalSettings__mail__fromAddress';
export const MAIL_FROM_NAME_CONFIG_KEY = 'globalSettings__mail__fromName';
export const MAIL_SECRET_CONFIG_KEY = 'globalSettings__mail__secret';
/** 语言 / 时区已改为**用户级**（`users.locale` / `users.timezone`），不再有对应的全局键。 */
/** 「上一次测试发信」的节流窗口；值是实现细节，仅用于原子认领。 */
export const MAIL_TEST_THROTTLE_CONFIG_KEY = 'globalSettings__mail__testThrottle';

/**
 * 与 `backup-settings-crypto.ts` 的常量必须是不同的值（域分离）。
 * 改动会让已存口令无法解开。
 */
const MAIL_SECRET_SALT = 'nodewarden.mail-settings.runtime.v1';
const MAIL_SECRET_INFO = 'mail-settings';

/** 平台硬禁端口：Workers 无法在 25 上建出站连接，保存时就拒绝。 */
const PROHIBITED_PORTS = new Set([25]);

const LIMITS = {
  host: 253,
  username: 255,
  fromAddress: 320,
  fromName: 128,
  password: 512,
} as const;

/** 校验失败 ⇒ handler 返回 400（而不是 500）。 */
export class MailSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailSettingsValidationError';
  }
}

export interface MailSettingsInput {
  enabled: boolean;
  host: string;
  port: number;
  /** 只读回显用；保存时忽略，加密方式由端口推断。 */
  encryption?: SmtpEncryption;
  username: string;
  fromAddress: string;
  fromName: string;
  /** 留空 / 省略表示「保持已有口令不变」。 */
  password?: string;
  /** 显式清除已存口令（与 `password` 同时给时以 `password` 为准）。 */
  clearPassword?: boolean;
}

/** 回给管理端的形态：**永远不含口令**，只告知「是否已设置」。 */
export interface MailSettingsPublic {
  enabled: boolean;
  host: string;
  port: number;
  encryption: SmtpEncryption;
  username: string;
  fromAddress: string;
  fromName: string;
  passwordConfigured: boolean;
  /** 参数是否完整到「可以尝试发信」。 */
  configured: boolean;
}

export const DEFAULT_MAIL_SETTINGS: MailSettingsPublic = {
  enabled: false,
  host: '',
  port: 587,
  encryption: 'starttls',
  username: '',
  fromAddress: '',
  fromName: '',
  passwordConfigured: false,
  configured: false,
};

/**
 * 邮件渲染偏好：语言与时区都取自**收件人自己**的偏好，与 SMTP 连接参数分开。
 *
 * `preferencesUnset` 标记「哪一项用的是回退值」，供模板在正文追加提示句。
 */
export interface MailRenderPreferences {
  locale: string;
  timezone: string;
  preferencesUnset: { locale: boolean; timezone: boolean };
}

/**
 * 把收件人偏好解析成渲染选项。
 *
 * **未设定与值非法都按「未设定」处理**：迁移或历史手工改库可能留下非法值，
 * 那时邮件实际会回退，若不算作未设定，就会出现「用户收到英文邮件却没有任何提示」。
 */
export function resolveMailRenderPreferences(
  recipient: { locale?: string | null; timezone?: string | null }
): MailRenderPreferences {
  const matchedLocale = matchMailLocale(recipient.locale);
  const timezone = typeof recipient.timezone === 'string' ? recipient.timezone.trim() : '';
  const timezoneValid = isValidTimeZone(timezone);
  return {
    locale: matchedLocale ?? DEFAULT_MAIL_LOCALE,
    timezone: timezoneValid ? timezone : DEFAULT_MAIL_TIMEZONE,
    preferencesUnset: { locale: matchedLocale === null, timezone: !timezoneValid },
  };
}

export type MailConnectionResolution =
  | { status: 'ok'; settings: SmtpConnectionSettings }
  | { status: 'not-configured' }
  | { status: 'secret-unreadable' };

/** 按端口推断加密方式：465 / 2465 是 SMTPS 惯例端口，其余默认 STARTTLS。 */
export function inferEncryption(port: number): SmtpEncryption {
  return port === 465 || port === 2465 ? 'implicit' : 'starttls';
}

function trimTo(value: unknown, max: number, label: string): string {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new MailSettingsValidationError(`${label} is too long (max ${max})`);
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松读取布尔：兼容 `true` / `'true'` / `1` / `'1'`。 */
function readBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

/**
 * 只做结构校验（类型 / 长度 / 端口范围）；主机可达性与口令正确性交给「测试发信」验证。
 */
export function normalizeMailSettingsInput(body: unknown): MailSettingsInput {
  if (!isPlainObject(body)) throw new MailSettingsValidationError('Request body must be a JSON object');

  const host = trimTo(body.host, LIMITS.host, 'SMTP host');
  const rawPort = body.port;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MailSettingsValidationError('SMTP port must be an integer between 1 and 65535');
  }
  if (PROHIBITED_PORTS.has(port)) {
    throw new MailSettingsValidationError(
      'Port 25 is prohibited on this platform; use 465, 587, 2465 or 2587 instead'
    );
  }

  // 加密方式一律由端口推断，不接受客户端指定：避免存下「587 却选隐式 TLS」这类必然失败的组合。
  const encryption = inferEncryption(port);

  const username = trimTo(body.username, LIMITS.username, 'SMTP username');
  const fromAddress = trimTo(body.fromAddress, LIMITS.fromAddress, 'Sender address');
  const fromName = trimTo(body.fromName, LIMITS.fromName, 'Sender name');
  const password = body.password === undefined || body.password === null
    ? ''
    : trimTo(body.password, LIMITS.password, 'SMTP password');

  if (host && !/^[A-Za-z0-9._-]+$/.test(host)) {
    throw new MailSettingsValidationError('SMTP host contains invalid characters');
  }
  // 只挡明显笔误，真正的地址合法性由 SMTP 服务器的 RCPT 决定
  if (fromAddress && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromAddress)) {
    throw new MailSettingsValidationError('Sender address is not a valid email address');
  }

  return {
    enabled: readBoolean(body.enabled),
    host,
    port,
    encryption,
    username,
    fromAddress,
    fromName,
    password,
    clearPassword: readBoolean(body.clearPassword),
  };
}

async function readMailConfigMap(db: D1Database): Promise<Map<string, string>> {
  const result = await db
    .prepare(
      'SELECT key, value FROM config WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      MAIL_ENABLED_CONFIG_KEY,
      MAIL_HOST_CONFIG_KEY,
      MAIL_PORT_CONFIG_KEY,
      MAIL_ENCRYPTION_CONFIG_KEY,
      MAIL_USERNAME_CONFIG_KEY,
      MAIL_FROM_ADDRESS_CONFIG_KEY,
      MAIL_FROM_NAME_CONFIG_KEY,
      MAIL_SECRET_CONFIG_KEY
    )
    .all<{ key: string; value: string }>();
  return new Map((result.results || []).map((row) => [row.key, String(row.value ?? '')]));
}

/** 读取给管理端看的配置（不含口令）。 */
export async function getMailSettings(db: D1Database): Promise<MailSettingsPublic> {
  const values = await readMailConfigMap(db);
  if (values.size === 0) return { ...DEFAULT_MAIL_SETTINGS };

  const host = (values.get(MAIL_HOST_CONFIG_KEY) || '').trim();
  const port = Number(values.get(MAIL_PORT_CONFIG_KEY));
  const resolvedPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_MAIL_SETTINGS.port;
  const rawEncryption = (values.get(MAIL_ENCRYPTION_CONFIG_KEY) || '').trim().toLowerCase();
  const encryption: SmtpEncryption =
    rawEncryption === 'implicit' || rawEncryption === 'starttls' ? rawEncryption : inferEncryption(resolvedPort);
  const username = (values.get(MAIL_USERNAME_CONFIG_KEY) || '').trim();
  const fromAddress = (values.get(MAIL_FROM_ADDRESS_CONFIG_KEY) || '').trim();
  const fromName = (values.get(MAIL_FROM_NAME_CONFIG_KEY) || '').trim();
  const passwordConfigured = (values.get(MAIL_SECRET_CONFIG_KEY) || '').length > 0;

  return {
    enabled: readBoolean(values.get(MAIL_ENABLED_CONFIG_KEY)),
    host,
    port: resolvedPort,
    encryption,
    username,
    fromAddress,
    fromName,
    passwordConfigured,
    configured: isMailSettingsUsable({ host, fromAddress, username, passwordConfigured }),
  };
}

function isMailSettingsUsable(parts: {
  host: string;
  fromAddress: string;
  username: string;
  passwordConfigured: boolean;
}): boolean {
  if (!parts.host || !parts.fromAddress) return false;
  // 无用户名的中继合法，此时不要求口令
  if (!parts.username) return true;
  return parts.passwordConfigured;
}

async function deriveSecretKey(env: Env): Promise<CryptoKey> {
  return deriveServerDomainKey(env.JWT_SECRET, MAIL_SECRET_SALT, MAIL_SECRET_INFO);
}

export async function readStoredMailPassword(db: D1Database, env: Env): Promise<string | null> {
  const raw = await getConfigValue(db, MAIL_SECRET_CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { iv?: unknown; ciphertext?: unknown };
    const iv = String(parsed?.iv ?? '');
    const ciphertext = String(parsed?.ciphertext ?? '');
    if (!iv || !ciphertext) return null;
    return await decryptDomainValue({ iv, ciphertext }, await deriveSecretKey(env));
  } catch {
    // 密文坏了（例如 JWT_SECRET 被换过）：当作没有口令，由上层给出可操作提示
    return null;
  }
}

/** `password` 留空表示保持原口令不变。 */
export async function saveMailSettings(
  db: D1Database,
  env: Env,
  input: MailSettingsInput
): Promise<MailSettingsPublic> {
  const existingSecret = input.clearPassword && !input.password
    ? null
    : await getConfigValue(db, MAIL_SECRET_CONFIG_KEY);

  if (!input.password && !existingSecret && input.username) {
    throw new MailSettingsValidationError(
      input.clearPassword
        ? 'A username cannot be kept while clearing the password; clear the username too, or provide a new password'
        : 'An SMTP password is required when a username is set'
    );
  }

  const statements = [
    [MAIL_ENABLED_CONFIG_KEY, input.enabled ? 'true' : 'false'],
    [MAIL_HOST_CONFIG_KEY, input.host],
    [MAIL_PORT_CONFIG_KEY, String(input.port)],
    [MAIL_ENCRYPTION_CONFIG_KEY, input.encryption],
    [MAIL_USERNAME_CONFIG_KEY, input.username],
    [MAIL_FROM_ADDRESS_CONFIG_KEY, input.fromAddress],
    [MAIL_FROM_NAME_CONFIG_KEY, input.fromName],
  ].map(([key, value]) =>
    db
      .prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, value)
  );

  if (input.password) {
    const envelope = await encryptDomainValue(input.password, await deriveSecretKey(env));
    statements.push(
      db
        .prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(MAIL_SECRET_CONFIG_KEY, JSON.stringify(envelope))
    );
  } else if (input.clearPassword && !existingSecret) {
    statements.push(db.prepare('DELETE FROM config WHERE key = ?').bind(MAIL_SECRET_CONFIG_KEY));
  }

  await db.batch(statements);
  return getMailSettings(db);
}

/** 清除已存口令（但不改动其它字段）。 */
export async function clearMailPassword(db: D1Database): Promise<MailSettingsPublic> {
  await db.prepare('DELETE FROM config WHERE key = ?').bind(MAIL_SECRET_CONFIG_KEY).run();
  return getMailSettings(db);
}

/**
 * 解析出可交给 SMTP 客户端的连接参数。
 * 三态是为了区分「还没配」与「配了但解不开」—— 处置动作不同。
 */
export async function resolveMailConnection(
  db: D1Database,
  env: Env
): Promise<MailConnectionResolution> {
  const settings = await getMailSettings(db);
  if (!settings.host || !settings.fromAddress) return { status: 'not-configured' };

  const password = await readStoredMailPassword(db, env);
  if (settings.username && password === null) return { status: 'secret-unreadable' };

  return {
    status: 'ok',
    settings: {
      host: settings.host,
      port: settings.port,
      encryption: settings.encryption,
      username: settings.username,
      password: password ?? '',
      fromAddress: settings.fromAddress,
      fromName: settings.fromName,
    },
  };
}

/**
 * 通知类邮件（验证码、安全告警）能否真的发出去。
 *
 * 比 `resolveMailConnection` 严格：还要求 `enabled`。管理员可以保留全部配置却关掉发送能力，
 * 此时不能给用户展示「发送验证码」入口 —— 那只会换来一个必然失败的按钮。
 */
export async function isMailDeliveryAvailable(db: D1Database, env: Env): Promise<boolean> {
  const settings = await getMailSettings(db);
  if (!settings.enabled) return false;
  return (await resolveMailConnection(db, env)).status === 'ok';
}

/**
 * `isMailDeliveryAvailable` 的**容错版**，供展示性判断用：查询失败按「不能发信」处理
 *（调用方据此报 `emailVerified: true`）—— 不能让一次查询拖垮 profile / sync / token 签发。
 */
export async function isMailDeliveryAvailableSoft(env: Env | undefined): Promise<boolean> {
  if (!env) return false;
  try {
    return await isMailDeliveryAvailable(env.DB, env);
  } catch {
    return false;
  }
}

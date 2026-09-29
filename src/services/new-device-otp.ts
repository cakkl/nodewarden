// 新设备验证（NDV）：陌生设备登录时发一枚邮件码，必须带码重登。
//
// 与 2FA 的区别：2FA 要用户**手动开启**且每次都拦；本功能**默认开启、只拦陌生设备**。
//
// ⚠️ 三条不可忘的约束：
// 1. 码**绑定 device_identifier**（哈希里混入）⇒ A 设备的码不能在 B 设备重放；
// 2. 调用方必须先过发信门禁 `emailAvailabilityForUser`（未验证邮箱 / 发不出信 ⇒ 不发、直接放行）；
// 3. 限流命中时**静默不发信**，且响应与其它情况一致（否则「被限流」就成了设备是否已验证的判据）。
import { randomCode, timingSafeEqual } from './email-verification';
import { bytesToBase64 } from './server-secret-crypto';
import { getConfigValue, setConfigValue } from './storage-config-repo';

/** 验证码有效期，对齐官方 5 分钟。 */
const NEW_DEVICE_OTP_TTL_MS = 5 * 60 * 1000;
/** 单枚码允许的错误尝试次数；超出即作废。 */
const NEW_DEVICE_OTP_MAX_ATTEMPTS = 5;
/** 同一 (用户, 设备) 两次发码之间的最小间隔。 */
const NEW_DEVICE_OTP_RESEND_INTERVAL_MS = 60 * 1000;
/** 同一 (用户, 设备) 每小时的发码上限。 */
const PAIR_PER_HOUR_LIMIT = 5;
/** 每个用户每天的发码上限（防发信放大）。 */
const USER_DAILY_LIMIT = 20;

const NEW_DEVICE_VERIFICATION_SETTING_KEY = 'globalSettings__security__newDeviceVerification';

async function hashCode(userId: string, deviceIdentifier: string, code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = new TextEncoder().encode(`${userId}:${deviceIdentifier}:${code}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64(new Uint8Array(signature));
}

function pairKey(userId: string, deviceIdentifier: string): string {
  return `newDeviceOtp__pair__${userId}__${deviceIdentifier}`;
}

function userKey(userId: string): string {
  return `newDeviceOtp__user__${userId}`;
}

interface PairCounters {
  last: number;
  hour: string;
  hourCount: number;
}

function readPairCounters(raw: string | null, now: Date): PairCounters {
  let parsed: Partial<PairCounters> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<PairCounters>;
    } catch {
      parsed = {};
    }
  }
  const hour = now.toISOString().slice(0, 13);
  return {
    last: typeof parsed.last === 'number' ? parsed.last : 0,
    hour,
    hourCount: parsed.hour === hour && typeof parsed.hourCount === 'number' ? parsed.hourCount : 0,
  };
}

interface UserCounters {
  day: string;
  dayCount: number;
}

function readUserCounters(raw: string | null, now: Date): UserCounters {
  let parsed: Partial<UserCounters> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<UserCounters>;
    } catch {
      parsed = {};
    }
  }
  const day = now.toISOString().slice(0, 10);
  return {
    day,
    dayCount: parsed.day === day && typeof parsed.dayCount === 'number' ? parsed.dayCount : 0,
  };
}

/** 只读地检查是否还能发码，不消耗配额。 */
export async function checkNewDeviceOtpQuota(
  db: D1Database,
  userId: string,
  deviceIdentifier: string,
  now: Date = new Date()
): Promise<{ allowed: true } | { allowed: false; reason: 'too-soon' | 'hourly-limit' | 'user-daily-limit' }> {
  const pair = readPairCounters(await getConfigValue(db, pairKey(userId, deviceIdentifier)), now);
  if (pair.last && now.getTime() - pair.last < NEW_DEVICE_OTP_RESEND_INTERVAL_MS) {
    return { allowed: false, reason: 'too-soon' };
  }
  if (pair.hourCount >= PAIR_PER_HOUR_LIMIT) {
    return { allowed: false, reason: 'hourly-limit' };
  }
  const user = readUserCounters(await getConfigValue(db, userKey(userId)), now);
  if (user.dayCount >= USER_DAILY_LIMIT) {
    return { allowed: false, reason: 'user-daily-limit' };
  }
  return { allowed: true };
}

/** 生成并持久化一枚新码，返回明文用于发信。调用方需先过门禁与 `checkNewDeviceOtpQuota`。 */
export async function issueNewDeviceOtp(
  db: D1Database,
  userId: string,
  deviceIdentifier: string,
  secret: string,
  now: Date = new Date()
): Promise<{ code: string; expiresAt: string }> {
  const code = randomCode();
  const expiresAt = new Date(now.getTime() + NEW_DEVICE_OTP_TTL_MS).toISOString();
  const codeHash = await hashCode(userId, deviceIdentifier, code, secret);

  // 顺手清掉该用户的过期行：本表按 (user_id, device_identifier) 增长，不清会随历史设备缓慢堆积。
  await db
    .prepare('DELETE FROM new_device_otps WHERE user_id = ? AND expires_at < ?')
    .bind(userId, now.toISOString())
    .run();
  await db
    .prepare(
      'INSERT INTO new_device_otps(user_id, device_identifier, code_hash, expires_at, attempts, created_at) VALUES(?, ?, ?, ?, 0, ?) ' +
        'ON CONFLICT(user_id, device_identifier) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at'
    )
    .bind(userId, deviceIdentifier, codeHash, expiresAt, now.toISOString())
    .run();

  const hour = now.toISOString().slice(0, 13);
  const pair = readPairCounters(await getConfigValue(db, pairKey(userId, deviceIdentifier)), now);
  await setConfigValue(
    db,
    pairKey(userId, deviceIdentifier),
    JSON.stringify({ last: now.getTime(), hour, hourCount: pair.hourCount + 1 } satisfies PairCounters)
  );

  const user = readUserCounters(await getConfigValue(db, userKey(userId)), now);
  await setConfigValue(
    db,
    userKey(userId),
    JSON.stringify({ day: user.day, dayCount: user.dayCount + 1 } satisfies UserCounters)
  );

  return { code, expiresAt };
}

/** 校验收件人提交的码。成功即作废（一次性）。 */
export async function verifyNewDeviceOtp(
  db: D1Database,
  userId: string,
  deviceIdentifier: string,
  code: string,
  secret: string,
  now: Date = new Date()
): Promise<'ok' | 'no-code' | 'expired' | 'too-many-attempts' | 'mismatch'> {
  const row = await db
    .prepare('SELECT code_hash, expires_at, attempts FROM new_device_otps WHERE user_id = ? AND device_identifier = ?')
    .bind(userId, deviceIdentifier)
    .first<{ code_hash: string; expires_at: string; attempts: number }>();
  if (!row) return 'no-code';
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await clearNewDeviceOtp(db, userId, deviceIdentifier);
    return 'expired';
  }
  if (row.attempts >= NEW_DEVICE_OTP_MAX_ATTEMPTS) {
    await clearNewDeviceOtp(db, userId, deviceIdentifier);
    return 'too-many-attempts';
  }
  const expected = await hashCode(userId, deviceIdentifier, code, secret);
  if (!timingSafeEqual(expected, row.code_hash)) {
    const attempts = row.attempts + 1;
    if (attempts >= NEW_DEVICE_OTP_MAX_ATTEMPTS) {
      await clearNewDeviceOtp(db, userId, deviceIdentifier);
      return 'too-many-attempts';
    }
    await db
      .prepare('UPDATE new_device_otps SET attempts = ? WHERE user_id = ? AND device_identifier = ?')
      .bind(attempts, userId, deviceIdentifier)
      .run();
    return 'mismatch';
  }
  await clearNewDeviceOtp(db, userId, deviceIdentifier);
  return 'ok';
}

async function clearNewDeviceOtp(db: D1Database, userId: string, deviceIdentifier: string): Promise<void> {
  await db
    .prepare('DELETE FROM new_device_otps WHERE user_id = ? AND device_identifier = ?')
    .bind(userId, deviceIdentifier)
    .run();
}

/** 用户关闭 / 重新开启该功能时清掉所有待用码。 */
export async function clearNewDeviceOtpsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM new_device_otps WHERE user_id = ?').bind(userId).run();
}

/**
 * 全局开关。**默认开启**（这就是本功能的目的）；配了 '0' 才关。
 *
 * ⚠️ 这是登录主路径的**保命开关**：出问题时把 `config` 表里这个键置 '0' 即可一键回到旧行为，不必等发版。
 */
export async function isNewDeviceVerificationEnabled(db: D1Database): Promise<boolean> {
  const raw = await getConfigValue(db, NEW_DEVICE_VERIFICATION_SETTING_KEY);
  return raw === null ? true : raw === '1';
}

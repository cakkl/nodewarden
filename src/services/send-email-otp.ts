// Send 邮箱 OTP：给「仅特定邮箱可用」的 Send 的收件人发码 / 验码。
//
// 与 email-verification 的差别：那两张表以**用户**为键，本表以 `(send_id, email)` 为键
// —— 收件人可能根本不是本站用户。哈希混入 `send_id`，A 的码不能拿到 B 的 Send 上重放。
//
// ⚠️ 限流状态存 `config`（两个维度：(send, email) 对 / Send 所有者）。调用方**必须**把限流命中
// 呈现成与「已发码」完全相同的响应，否则「是否被限流」就成了「该邮箱是否在名单里」的判据。
import { randomCode, timingSafeEqual } from './email-verification';
import { bytesToBase64 } from './server-secret-crypto';

/** 验证码有效期，对齐官方 5 分钟。 */
const SEND_OTP_CODE_TTL_MS = 5 * 60 * 1000;
/** 单个码允许的错误尝试次数；官方没有上限，这是我们加的。 */
const SEND_OTP_MAX_ATTEMPTS = 5;
/** 同一 (Send, 邮箱) 两次发码之间的最小间隔。 */
export const SEND_OTP_RESEND_INTERVAL_MS = 60 * 1000;
/** 同一 (Send, 邮箱) 每小时的发码上限。 */
const PAIR_PER_HOUR_LIMIT = 5;
/** 每个 Send 所有者每天最多发出多少封 Send 验证码。 */
const SEND_OTP_OWNER_DAILY_LIMIT = 50;

/** 名单/请求里的邮箱统一按小写存放与比较。 */
export function normalizeSendOtpEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

async function hashCode(sendId: string, email: string, code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = new TextEncoder().encode(`${sendId}:${email}:${code}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64(new Uint8Array(signature));
}

async function readConfigValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeConfigValue(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

function pairKey(sendId: string, email: string): string {
  return `sendOtp__pair__${sendId}__${email}`;
}

function ownerKey(ownerId: string): string {
  return `sendOtp__owner__${ownerId}`;
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

interface OwnerCounters {
  day: string;
  dayCount: number;
}

function readOwnerCounters(raw: string | null, now: Date): OwnerCounters {
  let parsed: Partial<OwnerCounters> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<OwnerCounters>;
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

type SendOtpThrottleReason = 'too-soon' | 'hourly-limit' | 'owner-daily-limit';

/**
 * 只读地检查是否还能发码，不消耗配额。
 *
 * ⚠️ 返回值**不得**直接暴露给客户端：命中限流时的响应必须与「已发码」逐字一致。
 */
export async function checkSendOtpQuota(
  db: D1Database,
  sendId: string,
  email: string,
  ownerId: string,
  now: Date = new Date()
): Promise<{ allowed: true } | { allowed: false; reason: SendOtpThrottleReason }> {
  const pair = readPairCounters(await readConfigValue(db, pairKey(sendId, email)), now);
  if (pair.last && now.getTime() - pair.last < SEND_OTP_RESEND_INTERVAL_MS) {
    return { allowed: false, reason: 'too-soon' };
  }
  if (pair.hourCount >= PAIR_PER_HOUR_LIMIT) {
    return { allowed: false, reason: 'hourly-limit' };
  }
  const owner = readOwnerCounters(await readConfigValue(db, ownerKey(ownerId)), now);
  if (owner.dayCount >= SEND_OTP_OWNER_DAILY_LIMIT) {
    return { allowed: false, reason: 'owner-daily-limit' };
  }
  return { allowed: true };
}

interface IssuedSendOtp {
  code: string;
  expiresAt: string;
}

/** 生成并持久化一枚新码，返回明文用于发信。调用方需先通过 `checkSendOtpQuota`。 */
export async function issueSendOtp(
  db: D1Database,
  sendId: string,
  email: string,
  ownerId: string,
  secret: string,
  now: Date = new Date()
): Promise<IssuedSendOtp> {
  const code = randomCode();
  const expiresAt = new Date(now.getTime() + SEND_OTP_CODE_TTL_MS).toISOString();
  const codeHash = await hashCode(sendId, email, code, secret);

  // 顺手清掉本 Send 的过期行：本表按 (send_id, email) 增长，不清会随「历史名单」缓慢堆积。  await db.prepare('DELETE FROM send_email_otps WHERE send_id = ? AND expires_at < ?').bind(sendId, now.toISOString()).run();
  await db
    .prepare(
      'INSERT INTO send_email_otps(send_id, email, code_hash, expires_at, attempts, created_at) VALUES(?, ?, ?, ?, 0, ?) ' +
        'ON CONFLICT(send_id, email) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at'
    )
    .bind(sendId, email, codeHash, expiresAt, now.toISOString())
    .run();

  const hour = now.toISOString().slice(0, 13);
  const pair = readPairCounters(await readConfigValue(db, pairKey(sendId, email)), now);
  await writeConfigValue(
    db,
    pairKey(sendId, email),
    JSON.stringify({ last: now.getTime(), hour, hourCount: pair.hourCount + 1 } satisfies PairCounters)
  );

  const owner = readOwnerCounters(await readConfigValue(db, ownerKey(ownerId)), now);
  await writeConfigValue(
    db,
    ownerKey(ownerId),
    JSON.stringify({ day: owner.day, dayCount: owner.dayCount + 1 } satisfies OwnerCounters)
  );

  return { code, expiresAt };
}

type SendOtpVerifyOutcome = 'ok' | 'no-code' | 'expired' | 'too-many-attempts' | 'mismatch';

/** 校验收件人提交的码。成功即作废（一次性）；失败只累加 attempts，不消费码。 */
export async function verifySendOtp(
  db: D1Database,
  sendId: string,
  email: string,
  code: string,
  secret: string,
  now: Date = new Date()
): Promise<SendOtpVerifyOutcome> {
  const row = await db
    .prepare('SELECT code_hash, expires_at, attempts FROM send_email_otps WHERE send_id = ? AND email = ?')
    .bind(sendId, email)
    .first<{ code_hash: string; expires_at: string; attempts: number }>();
  if (!row) return 'no-code';
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await clearSendOtp(db, sendId, email);
    return 'expired';
  }
  if (row.attempts >= SEND_OTP_MAX_ATTEMPTS) {
    await clearSendOtp(db, sendId, email);
    return 'too-many-attempts';
  }
  const expected = await hashCode(sendId, email, code, secret);
  if (!timingSafeEqual(expected, row.code_hash)) {
    const attempts = row.attempts + 1;
    if (attempts >= SEND_OTP_MAX_ATTEMPTS) {
      await clearSendOtp(db, sendId, email);
      return 'too-many-attempts';
    }
    await db
      .prepare('UPDATE send_email_otps SET attempts = ? WHERE send_id = ? AND email = ?')
      .bind(attempts, sendId, email)
      .run();
    return 'mismatch';
  }
  await clearSendOtp(db, sendId, email);
  return 'ok';
}

async function clearSendOtp(db: D1Database, sendId: string, email: string): Promise<void> {
  await db.prepare('DELETE FROM send_email_otps WHERE send_id = ? AND email = ?').bind(sendId, email).run();
}

/** 改名单 / 关闭邮箱认证时清掉相关码，避免旧码在新名单下仍然可用。 */
export async function clearSendOtpsForSend(db: D1Database, sendId: string): Promise<void> {
  await db.prepare('DELETE FROM send_email_otps WHERE send_id = ?').bind(sendId).run();
}

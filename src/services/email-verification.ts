// 邮箱验证码的生成、校验与发送限流。
//
// 设计要点：
// - 只存哈希，明文码仅存在于「发信」那一刻的返回值里。
// - 哈希混入 user_id，防止把 A 的码拿到 B 名下重放。
// - user_id 是 email_verification_tokens 的主键 ⇒ 每用户同时只有一个待用码。
// - 发送接口是公开的（未登录可调），所以限流必须落在服务端。
import { bytesToBase64 } from './server-secret-crypto';

/** 验证码有效期。 */
export const CODE_TTL_MS = 15 * 60 * 1000;
/** 单个验证码允许的错误尝试次数，超出即作废。 */
export const MAX_CODE_ATTEMPTS = 5;
/** 两次发码之间的最小间隔。 */
export const RESEND_INTERVAL_MS = 60 * 1000;
const PER_HOUR_LIMIT = 5;
const PER_DAY_LIMIT = 10;

export type IssueCodeFailure = 'too-soon' | 'hourly-limit' | 'daily-limit';

export interface IssuedCode {
  code: string;
  expiresAt: string;
}

async function hashCode(userId: string, email: string, code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = new TextEncoder().encode(`${userId}:${email.toLowerCase()}:${code}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64(new Uint8Array(signature));
}

function randomCode(): string {
  // 用拒绝采样避免取模偏置：2^32 不是 10^6 的整数倍。
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

/** 比较两个字符串是否相等，耗时与内容无关。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  // 长度不同也走完全程，避免用提前返回泄露长度信息。
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

interface Counters {
  last: number;
  hour: string;
  hourCount: number;
  day: string;
  dayCount: number;
}

function readCounters(raw: string | null | undefined, now: Date): Counters {
  let parsed: Partial<Counters> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<Counters>;
    } catch {
      parsed = {};
    }
  }
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  return {
    last: typeof parsed.last === 'number' ? parsed.last : 0,
    hour,
    hourCount: parsed.hour === hour && typeof parsed.hourCount === 'number' ? parsed.hourCount : 0,
    day,
    dayCount: parsed.day === day && typeof parsed.dayCount === 'number' ? parsed.dayCount : 0,
  };
}

function counterKey(userId: string): string {
  return `emailVerify__send__${userId}`;
}

/** 只读地检查是否还能发码，不消耗配额。 */
export async function checkSendQuota(
  db: D1Database,
  userId: string,
  now: Date = new Date()
): Promise<{ allowed: true } | { allowed: false; reason: IssueCodeFailure }> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(counterKey(userId)).first<{ value: string }>();
  const c = readCounters(row?.value, now);
  if (c.last && now.getTime() - c.last < RESEND_INTERVAL_MS) return { allowed: false, reason: 'too-soon' };
  if (c.hourCount >= PER_HOUR_LIMIT) return { allowed: false, reason: 'hourly-limit' };
  if (c.dayCount >= PER_DAY_LIMIT) return { allowed: false, reason: 'daily-limit' };
  return { allowed: true };
}

/** 消耗一次发送配额。调用方应先通过 checkSendQuota。 */
async function consumeSendQuota(db: D1Database, userId: string, now: Date): Promise<void> {
  const key = counterKey(userId);
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  const c = readCounters(row?.value, now);
  const next: Counters = {
    last: now.getTime(),
    hour: c.hour,
    hourCount: c.hourCount + 1,
    day: c.day,
    dayCount: c.dayCount + 1,
  };
  await db
    .prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(next))
    .run();
}

/** 生成并持久化一枚新码，返回明文用于发信。调用方需自行先校验配额。 */
export async function issueVerificationCode(
  db: D1Database,
  userId: string,
  email: string,
  secret: string,
  now: Date = new Date()
): Promise<IssuedCode> {
  const code = randomCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const codeHash = await hashCode(userId, email, code, secret);
  await db
    .prepare(
      'INSERT INTO email_verification_tokens(user_id, email, code_hash, expires_at, attempts, created_at) VALUES(?, ?, ?, ?, 0, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at'
    )
    .bind(userId, email.toLowerCase(), codeHash, expiresAt, now.toISOString())
    .run();
  await consumeSendQuota(db, userId, now);
  return { code, expiresAt };
}

export type VerifyCodeOutcome = 'ok' | 'no-code' | 'expired' | 'too-many-attempts' | 'mismatch';

/**
 * 校验用户提交的验证码。
 * 邮箱发生变化时旧码立即失效 —— 避免用户先收码、再改邮箱把验证转移到别的地址。
 */
export async function verifyEmailCode(
  db: D1Database,
  user: { id: string; email: string },
  code: string,
  secret: string,
  now: Date = new Date()
): Promise<VerifyCodeOutcome> {
  const row = await db
    .prepare('SELECT email, code_hash, expires_at, attempts FROM email_verification_tokens WHERE user_id = ?')
    .bind(user.id)
    .first<{ email: string; code_hash: string; expires_at: string; attempts: number }>();
  if (!row) return 'no-code';
  if (row.email !== user.email.toLowerCase()) return 'no-code';
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await clearVerificationCode(db, user.id);
    return 'expired';
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await clearVerificationCode(db, user.id);
    return 'too-many-attempts';
  }
  const expected = await hashCode(user.id, row.email, code, secret);
  if (!timingSafeEqual(expected, row.code_hash)) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await clearVerificationCode(db, user.id);
      return 'too-many-attempts';
    }
    await db.prepare('UPDATE email_verification_tokens SET attempts = ? WHERE user_id = ?').bind(attempts, user.id).run();
    return 'mismatch';
  }
  await clearVerificationCode(db, user.id);
  return 'ok';
}

export async function clearVerificationCode(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').bind(userId).run();
}

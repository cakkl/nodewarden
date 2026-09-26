// 邮件两步登录（2FA provider 1）的挑战码：生成、校验与发送限流。
//
// 与 `email-verification.ts` 分开实现：后者是「证明邮箱属于我」，本模块是「登录挑战」，
// 复用同一张表会让两者互相覆盖。设计要点与邮箱验证一致：只存哈希、哈希混入 user_id
//（防跨用户重放）、user_id 作主键（每用户同时只有一个待用码）、限流落在服务端。
import { bytesToBase64 } from './server-secret-crypto';
import { timingSafeEqual } from './email-verification';

/** 挑战码有效期。比邮箱验证短：登录场景用户就在屏幕前。 */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** 单个码允许的错误尝试次数，超出即作废。 */
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

async function hashCode(userId: string, code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = new TextEncoder().encode(`${userId}:2fa-email:${code}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64(new Uint8Array(signature));
}

function randomCode(): string {
  // 拒绝采样避免取模偏置：2^32 不是 10^6 的整数倍。
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
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

// 与邮箱验证的计数键分开：两者是独立的配额，不该互相消耗。
function counterKey(userId: string): string {
  return `twoFactorEmail__send__${userId}`;
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

/** 生成并持久化一枚新挑战码，返回明文用于发信。调用方需自行先校验配额。 */
export async function issueChallengeCode(
  db: D1Database,
  userId: string,
  secret: string,
  now: Date = new Date()
): Promise<IssuedCode> {
  const code = randomCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const codeHash = await hashCode(userId, code, secret);
  await db
    .prepare(
      'INSERT INTO two_factor_email_tokens(user_id, code_hash, expires_at, attempts, created_at) VALUES(?, ?, ?, 0, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at'
    )
    .bind(userId, codeHash, expiresAt, now.toISOString())
    .run();
  await consumeSendQuota(db, userId, now);
  return { code, expiresAt };
}

export type VerifyCodeOutcome = 'ok' | 'no-code' | 'expired' | 'too-many-attempts' | 'mismatch';

/** 校验用户提交的挑战码。成功即消费（删除），失败累加尝试次数。 */
export async function verifyChallengeCode(
  db: D1Database,
  userId: string,
  code: string,
  secret: string,
  now: Date = new Date()
): Promise<VerifyCodeOutcome> {
  const row = await db
    .prepare('SELECT code_hash, expires_at, attempts FROM two_factor_email_tokens WHERE user_id = ?')
    .bind(userId)
    .first<{ code_hash: string; expires_at: string; attempts: number }>();
  if (!row) return 'no-code';
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await clearChallengeCode(db, userId);
    return 'expired';
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await clearChallengeCode(db, userId);
    return 'too-many-attempts';
  }
  const expected = await hashCode(userId, code, secret);
  if (!timingSafeEqual(expected, row.code_hash)) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await clearChallengeCode(db, userId);
      return 'too-many-attempts';
    }
    await db.prepare('UPDATE two_factor_email_tokens SET attempts = ? WHERE user_id = ?').bind(attempts, userId).run();
    return 'mismatch';
  }
  await clearChallengeCode(db, userId);
  return 'ok';
}

export async function clearChallengeCode(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM two_factor_email_tokens WHERE user_id = ?').bind(userId).run();
}

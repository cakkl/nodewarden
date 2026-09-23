/**
 * 邮箱验证的单元测试。
 *
 * 覆盖两层：
 * - 服务层（验证码生成/校验/限流窗口）—— 直接打 DATABASE，不牵涉 HTTP；
 * - handler 层 —— 只走**不发信**的路径（邮件未配置、格式校验、提交正确码、取消验证）。
 *   发信路径需要 SMTP 握手，那部分由 `mail-smtp-client.test.ts` 的 stub 覆盖，这里不重复。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  RESEND_INTERVAL_MS,
  checkSendQuota,
  clearVerificationCode,
  issueVerificationCode,
  timingSafeEqual,
  verifyEmailCode,
} from '../src/services/email-verification';
import {
  handleGetEmailVerificationStatus,
  handleSendEmailVerificationCode,
  handleVerifyEmailCode,
} from '../src/handlers/account-email-verification';
import { getUserById } from '../src/services/storage-user-repo';
import type { Env } from '../src/types';
import { TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const USER_ID = '8f1c2f60-2b54-4d3e-9c11-6a2f7b8d0e01';
const USER_EMAIL = 'verify@example.test';

async function setup() {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL });
  const user = await getUserById(handle.db, USER_ID);
  assert.ok(user, '测试用户应能被读出');
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  return { handle, user, env };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://vault.example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://vault.example.test${path}`, { method: 'GET' });
}

// ---------------------------------------------------------------- 服务层

test('验证码是 6 位数字', async () => {
  const { handle } = await setup();
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(new Date(issued.expiresAt).getTime() - Date.now() > CODE_TTL_MS - 5000, true);
});

test('库里只存哈希，绝不出现明文码', async () => {
  const { handle } = await setup();
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  const rows = handle.connection.prepare('SELECT * FROM email_verification_tokens').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows[0]);
  assert.equal(serialized.includes(issued.code), false, '明文码不应出现在表里');
  assert.equal(typeof rows[0].code_hash, 'string');
});

test('正确码校验通过并被一次性消费', async () => {
  const { handle, user } = await setup();
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  assert.equal(await verifyEmailCode(handle.db, user, issued.code, TEST_JWT_SECRET), 'ok');
  // 消费后同一枚码不能再通过
  assert.equal(await verifyEmailCode(handle.db, user, issued.code, TEST_JWT_SECRET), 'no-code');
});

test('错误码返回 mismatch 并累加尝试次数', async () => {
  const { handle, user } = await setup();
  await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  assert.equal(await verifyEmailCode(handle.db, user, '000000', TEST_JWT_SECRET), 'mismatch');
  const row = handle.connection.prepare('SELECT attempts FROM email_verification_tokens WHERE user_id = ?').get(USER_ID) as { attempts: number };
  assert.equal(row.attempts, 1);
});

test('连续错误达上限后作废该码', async () => {
  const { handle, user } = await setup();
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  // 前 4 次是普通 mismatch，第 5 次触顶
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
    assert.equal(await verifyEmailCode(handle.db, user, '000000', TEST_JWT_SECRET), 'mismatch');
  }
  assert.equal(await verifyEmailCode(handle.db, user, '000000', TEST_JWT_SECRET), 'too-many-attempts');
  // 作废之后连正确的码也不再接受
  assert.equal(await verifyEmailCode(handle.db, user, issued.code, TEST_JWT_SECRET), 'no-code');
});

test('超过有效期返回 expired 并清掉该码', async () => {
  const { handle, user } = await setup();
  const now = new Date('2026-03-01T10:00:00.000Z');
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET, now);
  const later = new Date(now.getTime() + CODE_TTL_MS + 1000);
  assert.equal(await verifyEmailCode(handle.db, user, issued.code, TEST_JWT_SECRET, later), 'expired');
  const row = handle.connection.prepare('SELECT COUNT(*) AS count FROM email_verification_tokens').get() as { count: number };
  assert.equal(row.count, 0);
});

test('邮箱变更后旧码立即失效', async () => {
  const { handle, user } = await setup();
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  const renamed = { ...user, email: 'someone-else@example.test' };
  assert.equal(await verifyEmailCode(handle.db, renamed, issued.code, TEST_JWT_SECRET), 'no-code');
});

test('新码覆盖旧码：每个用户同时只有一个待用码', async () => {
  const { handle, user } = await setup();
  const first = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  const second = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  assert.equal(await verifyEmailCode(handle.db, user, first.code, TEST_JWT_SECRET), 'mismatch');
  assert.equal(await verifyEmailCode(handle.db, user, second.code, TEST_JWT_SECRET), 'ok');
});

test('timingSafeEqual 行为正确', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

// 发送配额：60 秒 / 5 次每小时 / 10 次每天

test('两次发码间隔不足 60 秒被拒', async () => {
  const { handle } = await setup();
  const now = new Date('2026-03-01T10:00:00.000Z');
  await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET, now);
  const tooSoon = await checkSendQuota(handle.db, USER_ID, new Date(now.getTime() + RESEND_INTERVAL_MS - 1000));
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.allowed === false && tooSoon.reason, 'too-soon');

  const ok = await checkSendQuota(handle.db, USER_ID, new Date(now.getTime() + RESEND_INTERVAL_MS + 1000));
  assert.equal(ok.allowed, true);
});

test('每小时第 6 次发码被拒', async () => {
  const { handle } = await setup();
  const base = new Date('2026-03-01T10:00:00.000Z');
  // 每次都跨过 60 秒冷却，且保持在同一小时桶里
  for (let i = 0; i < 5; i += 1) {
    await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET, new Date(base.getTime() + i * (RESEND_INTERVAL_MS + 1000)));
  }
  const sixth = await checkSendQuota(handle.db, USER_ID, new Date(base.getTime() + 5 * (RESEND_INTERVAL_MS + 1000)));
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.allowed === false && sixth.reason, 'hourly-limit');
});

test('每天第 11 次发码被拒（跨小时桶累计）', async () => {
  const { handle } = await setup();
  // 小时桶会随小时数变化而重置，日桶不会 —— 用 3 个小时发满 10 次
  for (let hour = 0; hour < 2; hour += 1) {
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.UTC(2026, 2, 1, 10 + hour, i, 0));
      await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET, at);
    }
  }
  const eleventh = await checkSendQuota(handle.db, USER_ID, new Date(Date.UTC(2026, 2, 1, 12, 0, 0)));
  assert.equal(eleventh.allowed, false);
  assert.equal(eleventh.allowed === false && eleventh.reason, 'daily-limit');
});

test('配额计数在跨天后重置', async () => {
  const { handle } = await setup();
  const day1 = new Date(Date.UTC(2026, 2, 1, 23, 0, 0));
  await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET, day1);
  const nextDay = await checkSendQuota(handle.db, USER_ID, new Date(Date.UTC(2026, 2, 2, 1, 0, 0)));
  assert.equal(nextDay.allowed, true);
});

// ---------------------------------------------------------------- handler 层

test('邮件未配置时状态查询返回 available=false', async () => {
  const { user, env } = await setup();
  const resp = await handleGetEmailVerificationStatus(get('/api/accounts/email-verification'), env, user);
  assert.equal(resp.status, 200);
  const body = await resp.json() as Record<string, unknown>;
  assert.equal(body.available, false);
  assert.equal(body.verified, false);
  assert.equal(body.email, USER_EMAIL);
  // 状态是会变的事实，不能允许缓存
  assert.equal(resp.headers.get('Cache-Control'), 'no-store');
});

test('邮件未配置时发码返回 503，且不写入验证码', async () => {
  const { handle, user, env } = await setup();
  const resp = await handleSendEmailVerificationCode(post('/api/accounts/email-token', {}), env, user);
  assert.equal(resp.status, 503);
  const row = handle.connection.prepare('SELECT COUNT(*) AS count FROM email_verification_tokens').get() as { count: number };
  assert.equal(row.count, 0);
});

test('请求体里带别的邮箱会被拒绝（本服务器不支持改邮箱）', async () => {
  const { user, env } = await setup();
  const resp = await handleSendEmailVerificationCode(
    post('/api/accounts/email-token', { email: 'other@example.test' }),
    env,
    user
  );
  assert.equal(resp.status, 409);
});

test('已验证状态下再发码返回 409', async () => {
  const { handle, env } = await setup();
  const verified = { ...(await getUserById(handle.db, USER_ID))!, emailVerified: true };
  const resp = await handleSendEmailVerificationCode(post('/api/accounts/email-token', {}), env, verified);
  assert.equal(resp.status, 409);
});

test('验证码格式不合法时返回 400', async () => {
  const { user, env } = await setup();
  for (const code of ['', '12345', '1234567', 'abcdef', '12 456']) {
    const resp = await handleVerifyEmailCode(post('/api/accounts/verify-email', { code }), env, user);
    assert.equal(resp.status, 400, `code=${JSON.stringify(code)} 应被拒绝`);
  }
});

test('提交正确码后落库并返回 verified=true', async () => {
  const { handle, user, env } = await setup();
  const issued = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  const resp = await handleVerifyEmailCode(post('/api/accounts/verify-email', { code: issued.code }), env, user);
  assert.equal(resp.status, 200);
  const body = await resp.json() as Record<string, unknown>;
  assert.equal(body.verified, true);

  const row = handle.connection.prepare('SELECT email_verified FROM users WHERE id = ?').get(USER_ID) as { email_verified: number };
  assert.equal(row.email_verified, 1);
  // 成功后状态查询应反映出来
  const status = await handleGetEmailVerificationStatus(get('/api/accounts/email-verification'), env, {
    ...user,
    emailVerified: true,
  });
  assert.equal((await status.json() as Record<string, unknown>).verified, true);
});

test('提交错误码返回 400 并带上具体原因', async () => {
  const { handle, user, env } = await setup();
  await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  const resp = await handleVerifyEmailCode(post('/api/accounts/verify-email', { code: '000000' }), env, user);
  assert.equal(resp.status, 400);
  const body = await resp.json() as Record<string, unknown>;
  assert.equal(body.reason, 'mismatch');
  const row = handle.connection.prepare('SELECT email_verified FROM users WHERE id = ?').get(USER_ID) as { email_verified: number };
  assert.equal(row.email_verified, 0);
});

test('没有待用码时提交返回 400', async () => {
  const { user, env } = await setup();
  const resp = await handleVerifyEmailCode(post('/api/accounts/verify-email', { code: '123456' }), env, user);
  assert.equal(resp.status, 400);
  assert.equal((await resp.json() as Record<string, unknown>).reason, 'no-code');
});

test('清除验证码是幂等的', async () => {
  const { handle } = await setup();
  await clearVerificationCode(handle.db, USER_ID);
  await clearVerificationCode(handle.db, USER_ID);
  const row = handle.connection.prepare('SELECT COUNT(*) AS count FROM email_verification_tokens').get() as { count: number };
  assert.equal(row.count, 0);
});

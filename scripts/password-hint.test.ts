/**
 * 主密码提示端点的行为测试。
 *
 * 核心是**防枚举**：配了 SMTP 时，四种情况（已验证 / 未验证 / 不存在 / 被禁用）
 * 的响应必须**完全一致** —— 否则「响应不同」就能被用来判断某个邮箱是否注册过。
 *
 * 发信路径需要 SMTP 握手，由 `mail-smtp-client.test.ts` 的 stub 覆盖，这里只测响应形态。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGetPasswordHint } from '../src/handlers/accounts';
import { saveMailSettings } from '../src/services/mail-settings';
import { saveUserPreferences } from '../src/services/storage-user-repo';
import type { Env } from '../src/types';
import { TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const USER_ID = '3f1c2f60-2b54-4d3e-9c11-6a2f7b8d0e03';
const USER_EMAIL = 'hint@example.test';
const HINT = 'my secret hint';

async function setup() {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL });
  // insertUser 不写 master_password_hint（列默认 NULL），这里显式设置。
  handle.connection.prepare('UPDATE users SET master_password_hint = ? WHERE id = ?').run(HINT, USER_ID);
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  return { handle, env };
}

/** 配好 SMTP，使 `isMailDeliveryAvailable` 为 true。 */
async function enableMail(env: Env): Promise<void> {
  await saveMailSettings(env.DB, env, {
    enabled: true,
    host: 'smtp.test',
    port: 587,
    encryption: 'starttls',
    username: 'mailer',
    fromAddress: 'noreply@test',
    fromName: 'NodeWarden',
    password: 'secret',
  });
}

/** 每次用不同 IP，避免撞上 1/分钟 的限流（限流本身由既有测试覆盖）。 */
let ipCounter = 0;
function hintRequest(email: string, ip?: string): Request {
  ipCounter += 1;
  return new Request('https://vault.example/api/accounts/password-hint', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': ip ?? `203.0.113.${ipCounter}`,
    },
    body: JSON.stringify({ email }),
  });
}

// ─────────────────────────── 配了 SMTP：一律走邮箱 ───────────────────────────

test('配了 SMTP + 已验证：返回 sent，且**不含**提示明文', async () => {
  const { handle, env } = await setup();
  await enableMail(env);
  await saveUserPreferences(handle.db, USER_ID, { twoFactorEmailEnabled: false });
  handle.connection.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(USER_ID);

  const response = await handleGetPasswordHint(hintRequest(USER_EMAIL), env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.sent, true);
  assert.equal(body.masterPasswordHint, undefined, '配了 SMTP 时不得返回明文');
});

test('配了 SMTP + 未验证：返回 sent（不发信），响应与已验证**完全一致**', async () => {
  const { env } = await setup();
  await enableMail(env);

  const response = await handleGetPasswordHint(hintRequest(USER_EMAIL), env);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, { object: 'passwordHint', sent: true }, '未验证时响应必须与已验证一致（防枚举）');
});

test('配了 SMTP + 用户不存在：响应与「存在」**完全一致**（防枚举）', async () => {
  const { env } = await setup();
  await enableMail(env);

  const response = await handleGetPasswordHint(hintRequest('nobody@example.test'), env);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, { object: 'passwordHint', sent: true }, '不存在时响应必须与存在时一致（防枚举）');
});

test('配了 SMTP + 用户被禁用：响应与「正常用户」**完全一致**（防枚举）', async () => {
  const { handle, env } = await setup();
  await enableMail(env);
  handle.connection.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(USER_ID);

  const response = await handleGetPasswordHint(hintRequest(USER_EMAIL), env);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, { object: 'passwordHint', sent: true }, '被禁用时响应必须与正常用户一致（防枚举）');
});

// ─────────────────────────── 未配 SMTP：保持明文 ───────────────────────────

test('未配 SMTP + 用户存在：返回明文提示', async () => {
  const { env } = await setup();

  const response = await handleGetPasswordHint(hintRequest(USER_EMAIL), env);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.masterPasswordHint, HINT);
  assert.equal(body.sent, undefined, '未配 SMTP 时不应带 sent 标记');
});

test('未配 SMTP + 用户不存在：与「存在但无提示」形态一致（防枚举）', async () => {
  const { handle, env } = await setup();
  // 造一个「存在但没有提示」的用户（insertUser 不写 master_password_hint，列默认 NULL）
  insertUser(handle.connection, 'no-hint-user', { email: 'nohint@example.test' });

  // 每次用不同 IP，避免撞上 1/分钟 的限流
  const missing = (await (await handleGetPasswordHint(hintRequest('nobody@example.test', '203.0.113.11'), env)).json()) as Record<string, unknown>;
  const noHint = (await (await handleGetPasswordHint(hintRequest('nohint@example.test', '203.0.113.12'), env)).json()) as Record<string, unknown>;

  assert.deepEqual(missing, noHint, '「不存在」与「存在但无提示」必须无法区分（防枚举）');
  assert.equal(missing.masterPasswordHint, null);
  assert.equal(missing.hasHint, undefined, '不得再用 hasHint 暴露存在性');
});

// ─────────────────────────── 限流：报最长的等待时间 ───────────────────────────

test('两级限流都触发时，报**最长**的等待时间（不是先撞上的那个）', async () => {
  const { handle, env } = await setup();
  const ip = '203.0.113.200';

  // 直接预置限流桶：分钟级与小时级都已超限（避免依赖真实调用顺序）。
  // 桶键格式见 ratelimit.ts：`${identifier}:${windowStart}`，identifier 为
  // `${normalizeClientIpForRateLimit(ip)}:password-hint[-hour]`（IPv4 带 `ip4:` 前缀）。
  const nowSec = Math.floor(Date.now() / 1000);
  const minuteStart = nowSec - (nowSec % 60);
  const hourStart = nowSec - (nowSec % 3600);
  const insert = handle.connection.prepare(
    'INSERT OR REPLACE INTO rate_limit_buckets(bucket_key, count, expires_at, updated_at) VALUES(?, ?, ?, ?)'
  );
  insert.run(`ip4:${ip}:password-hint:${minuteStart}`, 99, (minuteStart + 60) * 1000, Date.now());
  insert.run(`ip4:${ip}:password-hint-hour:${hourStart}`, 99, (hourStart + 3600) * 1000, Date.now());

  const response = await handleGetPasswordHint(hintRequest(USER_EMAIL, ip), env);
  assert.equal(response.status, 429);

  const retryAfter = Number(response.headers.get('Retry-After'));
  assert.ok(retryAfter > 60, `应报小时级窗口的等待时间（> 60 秒），实际 ${retryAfter}`);

  const body = (await response.json()) as Record<string, unknown>;
  assert.match(String(body.error_description), new RegExp(`in ${retryAfter} seconds`), '正文与 Retry-After 必须一致');
});

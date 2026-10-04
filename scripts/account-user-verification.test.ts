// User Verification 邮箱码（`request-otp` / `verify-otp`）的协议级验收。
//
// 盯三件事：① **路由必须命中真实 handler**（这两条曾在 501 桩列表里 ⇒ 直调 handler 测不到）；
// ② 「未验证邮箱 / 发不出信 ⇒ 一封都不发」；③ 字段名大小写不对称（`verify-otp` 用大写 `OTP`）。
//
// 运行方式：npm run test:account-otp
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequestAccountOtp, handleVerifyAccountOtp } from '../src/handlers/accounts-user-verification';
import { handleAuthenticatedRoute } from '../src/router-authenticated';
import { AuthService } from '../src/services/auth';
import { saveMailSettings } from '../src/services/mail-settings';
import { StorageService } from '../src/services/storage';
import type { Env, User } from '../src/types';
import {
  getSmtpConnectCalls,
  getSmtpDataBodies,
  resetSmtpScript,
  setSmtpScript,
} from './lib/cloudflare-sockets-stub.mjs';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'uv000000-0000-4000-8000-000000000001';
const USER_EMAIL = 'uv@example.test';
const CLIENT_HASH = 'client-side-hash-of-master-password';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  env: Env;
}

async function setup(options: { emailVerified?: boolean; mailConfigured?: boolean } = {}): Promise<Harness> {
  const handle = await createSchemaDatabase();
  const env = {
    DB: handle.db,
    JWT_SECRET: TEST_JWT_SECRET,
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
  } as unknown as Env;

  if (options.mailConfigured !== false) {
    await saveMailSettings(env.DB, env, {
      enabled: true,
      host: 'smtp.test',
      port: 587,
      encryption: 'starttls',
      username: '',
      fromAddress: 'noreply@example.test',
      fromName: 'NodeWarden',
    });
  }

  const masterPasswordHash = await new AuthService(env).hashPasswordServer(CLIENT_HASH);
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL, masterPasswordHash });
  handle.connection
    .prepare('UPDATE users SET email_verified = ? WHERE id = ?')
    .run(options.emailVerified === false ? 0 : 1, USER_ID);
  return { handle, env };
}

/** `request-otp` 的官方请求体是空的（客户端 `send("POST", "/accounts/request-otp", null)`）。 */
function otpRequest(path: string, body?: unknown): Request {
  return new Request(`https://vault.example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function requestOtp(h: Harness): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleRequestAccountOtp(otpRequest('/accounts/request-otp'), h.env, USER_ID);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function verifyOtp(h: Harness, body: unknown): Promise<{ status: number; raw: string }> {
  const response = await handleVerifyAccountOtp(otpRequest('/accounts/verify-otp', body), h.env, USER_ID);
  return { status: response.status, raw: await response.text() };
}

function countCodes(h: Harness): number {
  const row = h.handle.connection
    .prepare('SELECT COUNT(*) AS total FROM two_factor_email_tokens WHERE user_id = ?')
    .get(USER_ID) as { total: number };
  return row.total;
}

/** 从投递出去的邮件里取回 6 位验证码（正文是 base64 分段编码，见 `buildMimeMessage`）。 */
function lastDeliveredCode(): string {
  const parts: string[] = [];
  let payload: string[] = [];
  let inBody = false;
  const flush = (): void => {
    if (!payload.length) return;
    parts.push(Buffer.from(payload.join(''), 'base64').toString('utf8'));
    payload = [];
  };
  for (const line of getSmtpDataBodies().join('\r\n').split('\r\n')) {
    if (line.startsWith('--nw-')) {
      flush();
      inBody = false;
      continue;
    }
    if (line.startsWith('Content-Transfer-Encoding:')) {
      inBody = true;
      continue;
    }
    if (inBody && line !== '') payload.push(line);
  }
  flush();
  const match = parts.join('\n').match(/\b(\d{6})\b/);
  assert.ok(match, '邮件正文里应当能找到 6 位验证码');
  return match![1];
}

// ---------------------------------------------------------------- 路由级（直调 handler 测不到）

test('路由级：两条路径都命中真实 handler，而不是 501 桩', async () => {
  const h = await setup();
  const user = (await new StorageService(h.env.DB).getUserById(USER_ID)) as User;
  setSmtpScript();
  try {
    for (const path of ['/accounts/request-otp', '/api/accounts/request-otp']) {
      const response = await handleAuthenticatedRoute(otpRequest(path), h.env, USER_ID, user, path, 'POST');
      assert.ok(response, `${path} 应当被显式处理（返回 null 即 404）`);
      // 踩过的坑：留在 `mailBackedAccountPaths` 里 ⇒ 「Email link and email OTP flows are not implemented」
      assert.notEqual(response.status, 501, `${path} 不得被 501 桩拦下`);
      // 第二条路径会撞上 60 秒重发间隔 ⇒ 429；两者都说明「已进入真实 handler」
      assert.ok([200, 429].includes(response.status), `${path} 状态应为 200/429，实际 ${response.status}`);
    }
    assert.equal(getSmtpConnectCalls().length, 1, '第二次命中应被 60 秒重发间隔拦下（不发第二封）');

    const verify = await handleAuthenticatedRoute(
      otpRequest('/api/accounts/verify-otp', { OTP: '000000' }),
      h.env,
      USER_ID,
      user,
      '/api/accounts/verify-otp',
      'POST'
    );
    assert.ok(verify);
    assert.notEqual(verify.status, 501);
    assert.equal(verify.status, 400, '错码应 400（不是 501）');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 发码

test('发码：200 + 发一封 + 落一枚待用码（空的请求体也要能吃下）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const result = await requestOtp(h);
    assert.equal(result.status, 200);
    assert.equal(getSmtpConnectCalls().length, 1);
    assert.equal(countCodes(h), 1);
    assert.match(lastDeliveredCode(), /^[0-9]{6}$/);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('发码：60 秒内重复请求 ⇒ 429 且不发第二封', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    assert.equal((await requestOtp(h)).status, 200);
    const again = await requestOtp(h);
    assert.equal(again.status, 429);
    assert.equal(getSmtpConnectCalls().length, 1);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('发码：邮箱未验证 ⇒ 400 + 零发信 + 零存码（跨功能硬原则）', async () => {
  const h = await setup({ emailVerified: false });
  setSmtpScript();
  try {
    const result = await requestOtp(h);
    assert.equal(result.status, 400);
    assert.equal(getSmtpConnectCalls().length, 0, '一封都不能发');
    assert.equal(countCodes(h), 0, '不该留下任何待用码');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('发码：服务器没配邮件 ⇒ 503 + 零发信', async () => {
  const h = await setup({ mailConfigured: false });
  setSmtpScript();
  try {
    const result = await requestOtp(h);
    assert.equal(result.status, 503);
    assert.equal(getSmtpConnectCalls().length, 0);
    assert.equal(countCodes(h), 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 验码

test('验码：大写 `OTP` 命中 ⇒ 200，且码一次性（重放 400）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    await requestOtp(h);
    const code = lastDeliveredCode();

    const ok = await verifyOtp(h, { OTP: code });
    assert.equal(ok.status, 200);
    assert.equal(countCodes(h), 0, '成功即消费');

    const replay = await verifyOtp(h, { OTP: code });
    assert.equal(replay.status, 400);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('验码：小写 `otp` 也接受（敏感请求体用的小写拼写）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    await requestOtp(h);
    assert.equal((await verifyOtp(h, { otp: lastDeliveredCode() })).status, 200);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('验码：错 5 次即作废，之后正确的码也不再可用', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    await requestOtp(h);
    const code = lastDeliveredCode();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal((await verifyOtp(h, { OTP: '000000' })).status, 400, `第 ${attempt} 次错码应 400`);
    }
    assert.equal(countCodes(h), 0, '第 5 次错码后应清掉');
    assert.equal((await verifyOtp(h, { OTP: code })).status, 400, '作废后正确码也不能用');
    assert.equal(getSmtpConnectCalls().length, 1, '猜码不产生新邮件');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('验码：缺码 / 没有待用码 ⇒ 400', async () => {
  const h = await setup();
  try {
    assert.equal((await verifyOtp(h, {})).status, 400, '缺码');
    assert.equal((await verifyOtp(h, { OTP: '123456' })).status, 400, '没有待用码');
  } finally {
    h.handle.close();
  }
});

test('合规：发信失败时作废刚写的码（用户拿不到码，库里不该留）', async () => {
  const h = await setup();
  // `failConnect: true` ⇒ 连接直接抛错（模拟服务商不可达）
  setSmtpScript({ failConnect: true });
  try {
    const result = await requestOtp(h);
    assert.equal(result.status, 503);
    assert.equal(countCodes(h), 0, '发信失败必须回滚码');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

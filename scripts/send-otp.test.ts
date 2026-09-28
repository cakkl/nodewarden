/**
 * Send「限特定邮箱」访问（邮箱 OTP）的行为验收。
 * 盯的是三类**静默**失效（都不报错，只能靠断言钉住）：① **枚举**：名单外与「已发码」的响应必须逐字相同
 * ② **滥发**：不该发信时真的没有出站连接 ③ **一次性与作废**：用后即废 / 错 5 次作废 / 名单改动后作废。
 *
 * 运行方式：npm run test:send-otp
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleToken } from '../src/handlers/identity';
import { handleCreateSend, handleUpdateSend } from '../src/handlers/sends-private';
import { handleAccessSendV2, issueSendAccessToken, type SendAccessCredentials } from '../src/handlers/sends-public';
import { SEND_EMAIL_LIST_MAX, base64UrlEncode } from '../src/handlers/sends-shared';
import { saveMailSettings } from '../src/services/mail-settings';
import { SEND_OTP_RESEND_INTERVAL_MS } from '../src/services/send-email-otp';
import type { Env } from '../src/types';
import {
  getSmtpConnectCalls,
  getSmtpDataBodies,
  resetSmtpScript,
  setSmtpScript,
} from './lib/cloudflare-sockets-stub.mjs';
import { FIXED_NOW, TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const OWNER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OWNER_EMAIL = 'owner@example.test';
const LISTED_EMAIL = 'listed@example.test';
const UNLISTED_EMAIL = 'stranger@example.test';
const CLIENT_IP = '203.0.113.9';
const SEND_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
/** 免加盐路径用的 32 字节哈希（直接 base64url 比较，不必跑 PBKDF2） */
const PASSWORD_HASH_B64 = base64UrlEncode(new Uint8Array(32).fill(7));

/**
 * Node 里没有 Cache API，而身份端点的**公开限流**走 `caches.open()`（`ratelimit.ts` 的
 * `consumeFixedWindowBudget`）。这里装一个够用的内存实现，否则调 `handleToken` 会
 * 直接抛 `caches is not defined`。
 */
function installCacheStub(): void {
  const store = new Map<string, string>();
  const cache = {
    match: async (request: Request): Promise<Response | undefined> => {
      const value = store.get(request.url);
      return value === undefined ? undefined : new Response(value);
    },
    put: async (request: Request, response: Response): Promise<void> => {
      store.set(request.url, await response.text());
    },
  };
  (globalThis as unknown as { caches: { open: () => Promise<typeof cache> } }).caches = {
    open: async () => cache,
  };
}

installCacheStub();

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  env: Env;
}

async function setup(options: { mailConfigured?: boolean } = {}): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, OWNER_ID, { email: OWNER_EMAIL });
  const env = {
    DB: handle.db,
    JWT_SECRET: TEST_JWT_SECRET,
    // 创建 / 更新 Send 会广播实时通知；不提供桩会打一堆无害的报错日志
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
  return { handle, env };
}

/** `send_id` 是 base64url(16 字节 UUID)，与 `toAccessId` 同算法 */
function accessIdFor(sendId: string): string {
  const hex = sendId.replace(/-/g, '').toLowerCase();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base64UrlEncode(bytes);
}

function seedSend(
  h: Harness,
  options: { emails?: string | null; passwordHash?: string | null; id?: string } = {}
): string {
  const id = options.id ?? SEND_ID;
  h.handle.connection
    .prepare(
      'INSERT INTO sends (id, user_id, type, name, data, key, password_hash, password_salt, password_iterations, auth_type, emails, max_access_count, access_count, disabled, created_at, updated_at, expiration_date, deletion_date) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      OWNER_ID,
      0,
      'send-name',
      JSON.stringify({ text: 'ciphertext' }),
      'send-key',
      options.passwordHash ?? null,
      null,
      null,
      options.emails ? 0 : options.passwordHash ? 1 : 2,
      options.emails ?? null,
      null,
      0,
      0,
      FIXED_NOW,
      FIXED_NOW,
      null,
      new Date(Date.now() + 86_400_000).toISOString()
    );
  return accessIdFor(id);
}

function identitySendAccessRequest(payload: Record<string, string>): Request {
  return new Request('https://vault.example.test/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': CLIENT_IP },
    body: new URLSearchParams({ grant_type: 'send_access', scope: 'api.send', client_id: 'send', ...payload }).toString(),
  });
}

async function accessError(
  env: Env,
  accessId: string,
  credentials: SendAccessCredentials = {}
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const result = await issueSendAccessToken(env, accessId, credentials);
  assert.ok('error' in result, '前置条件：这次访问应当失败');
  const raw = await (result as { error: Response }).error.text();
  return {
    status: (result as { error: Response }).error.status,
    body: JSON.parse(raw) as Record<string, unknown>,
    raw,
  };
}

async function accessToken(env: Env, accessId: string, credentials: SendAccessCredentials = {}): Promise<string> {
  const result = await issueSendAccessToken(env, accessId, credentials);
  assert.ok('token' in result, '这次访问应当成功签发令牌');
  return (result as { token: string }).token;
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

// ---------------------------------------------------------------- 错误码契约（官方逐字一致）

test('send_access：缺 send_id ⇒ invalid_request + send_id_required', async () => {
  const h = await setup();
  try {
    const response = await handleToken(identitySendAccessRequest({}), h.env);
    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.send_access_error_type, 'send_id_required');
    assert.equal(body.error, 'invalid_request');
  } finally {
    h.handle.close();
  }
});

test('send_access：Send 不存在 ⇒ invalid_grant + send_id_invalid', async () => {
  const h = await setup();
  try {
    const { status, body } = await accessError(h.env, accessIdFor('99999999-9999-4999-8999-999999999999'));
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_grant');
    assert.equal(body.send_access_error_type, 'send_id_invalid');
  } finally {
    h.handle.close();
  }
});

test('send_access：免认证的 Send 直接签发令牌，且令牌能用于 /api/sends/access', async () => {
  const h = await setup();
  try {
    const accessId = seedSend(h);
    const token = await accessToken(h.env, accessId);

    const response = await handleAccessSendV2(
      new Request('https://vault.example.test/api/sends/access', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': CLIENT_IP },
      }),
      h.env
    );
    assert.equal(response.status, 200);
  } finally {
    h.handle.close();
  }
});

test('send_access：密码 Send 分别返回 required / invalid / 成功', async () => {
  const h = await setup();
  try {
    const accessId = seedSend(h, { passwordHash: PASSWORD_HASH_B64 });

    const missing = await accessError(h.env, accessId, {});
    assert.equal(missing.body.send_access_error_type, 'password_hash_b64_required');

    const wrong = await accessError(h.env, accessId, { passwordHashB64: base64UrlEncode(new Uint8Array(32).fill(9)) });
    assert.equal(wrong.body.send_access_error_type, 'password_hash_b64_invalid');

    const token = await accessToken(h.env, accessId, { passwordHashB64: PASSWORD_HASH_B64 });
    assert.ok(token.length > 0);
  } finally {
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 邮箱 OTP

test('邮箱 OTP：缺 email ⇒ email_required，且不接触发信', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    const { status, body } = await accessError(h.env, accessId, {});
    assert.equal(status, 400);
    assert.equal(body.send_access_error_type, 'email_required');
    assert.equal(getSmtpConnectCalls().length, 0, '缺 email 时不该有任何出站连接');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：名单外邮箱与「已发码」响应逐字一致，且一封不发', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });

    const listed = await accessError(h.env, accessId, { email: LISTED_EMAIL });
    assert.equal(listed.body.send_access_error_type, 'email_and_otp_required');
    assert.equal(getSmtpConnectCalls().length, 1, '名单内应当真发一封');

    const unlisted = await accessError(h.env, accessId, { email: UNLISTED_EMAIL });
    assert.equal(unlisted.status, listed.status);
    assert.equal(unlisted.raw, listed.raw, '两种情况的响应体必须逐字一致（防枚举）');
    assert.equal(getSmtpConnectCalls().length, 1, '名单外不该增加出站连接');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：正确的码签发令牌且一次性；重放失败', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    await accessError(h.env, accessId, { email: LISTED_EMAIL });
    const code = lastDeliveredCode();

    const token = await accessToken(h.env, accessId, { email: LISTED_EMAIL, otp: code });
    assert.ok(token.length > 0);

    const replay = await accessError(h.env, accessId, { email: LISTED_EMAIL, otp: code });
    assert.equal(replay.body.send_access_error_type, 'email_and_otp_required', '用过的码必须作废');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：错码 5 次后作废，正确的码也不再接受', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    await accessError(h.env, accessId, { email: LISTED_EMAIL });
    const code = lastDeliveredCode();

    for (let i = 0; i < 5; i += 1) {
      const wrong = await accessError(h.env, accessId, { email: LISTED_EMAIL, otp: '000000' });
      assert.equal(wrong.body.send_access_error_type, 'email_and_otp_required');
    }

    const afterLockout = await accessError(h.env, accessId, { email: LISTED_EMAIL, otp: code });
    assert.equal(afterLockout.body.send_access_error_type, 'email_and_otp_required', '超过尝试次数后码应已作废');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：重发间隔内静默抑制（响应一致、第二封不发）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    const first = await accessError(h.env, accessId, { email: LISTED_EMAIL });
    assert.equal(getSmtpConnectCalls().length, 1);

    const second = await accessError(h.env, accessId, { email: LISTED_EMAIL });
    assert.equal(second.raw, first.raw, '被限流时的响应必须与已发码一致');
    assert.equal(getSmtpConnectCalls().length, 1, `${SEND_OTP_RESEND_INTERVAL_MS}ms 内不该再发一封`);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：邮箱大小写与空格归一化后仍能命中名单', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    await accessError(h.env, accessId, { email: `  ${LISTED_EMAIL.toUpperCase()}  ` });
    assert.equal(getSmtpConnectCalls().length, 1, '归一化后应当命中名单并发出邮件');

    const code = lastDeliveredCode();
    const token = await accessToken(h.env, accessId, { email: LISTED_EMAIL, otp: code });
    assert.ok(token.length > 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：名单为空串的 Send fail closed —— 绝不签发令牌', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: '' });
    const bare = await accessError(h.env, accessId, {});
    assert.equal(bare.body.send_access_error_type, 'email_required');

    const withEmail = await accessError(h.env, accessId, { email: LISTED_EMAIL });
    assert.equal(withEmail.body.send_access_error_type, 'email_and_otp_required');
    assert.equal(getSmtpConnectCalls().length, 0, '名单为空 ⇒ 任何邮箱都不在名单里，一封不发');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱 OTP：服务器发不出邮件 ⇒ 503 email_delivery_unavailable（与名单无关，不泄信息）', async () => {
  const h = await setup({ mailConfigured: false });
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    const listed = await accessError(h.env, accessId, { email: LISTED_EMAIL });
    const unlisted = await accessError(h.env, accessId, { email: UNLISTED_EMAIL });

    assert.equal(listed.status, 503);
    assert.equal(listed.body.send_access_error_type, 'email_delivery_unavailable');
    assert.equal(unlisted.raw, listed.raw, '邮件不可用时两种情况也必须一致');
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 创建 / 更新侧

const TOMORROW = new Date(Date.now() + 86_400_000).toISOString();

function createSendRequest(body: Record<string, unknown>): Request {
  return new Request('https://vault.example.test/api/sends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 0,
      name: 'send',
      key: 'key-material',
      text: { text: 'ciphertext' },
      deletionDate: TOMORROW,
      ...body,
    }),
  });
}

test('创建：未配邮件时带名单 ⇒ 503（不让用户造出打不开的 Send）', async () => {
  const h = await setup({ mailConfigured: false });
  try {
    const response = await handleCreateSend(createSendRequest({ emails: LISTED_EMAIL }), h.env, OWNER_ID);
    assert.equal(response.status, 503);
  } finally {
    h.handle.close();
  }
});

test('创建：名单被规范化（小写、去重），并回显在响应里', async () => {
  const h = await setup();
  try {
    const response = await handleCreateSend(
      createSendRequest({ emails: ` ${LISTED_EMAIL.toUpperCase()} , ${LISTED_EMAIL} ` }),
      h.env,
      OWNER_ID
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { emails?: string; authType?: number };
    assert.equal(body.emails, LISTED_EMAIL);
    assert.equal(body.authType, 0, '名单非空 ⇒ authType 应报 Email(0)');
  } finally {
    h.handle.close();
  }
});

test('创建：名单非法项 / 超过 20 项一律 400', async () => {
  const h = await setup();
  try {
    const invalid = await handleCreateSend(createSendRequest({ emails: 'not-an-email' }), h.env, OWNER_ID);
    assert.equal(invalid.status, 400);

    const many = Array.from({ length: 21 }, (_, i) => `user${i}@example.test`).join(',');
    const tooMany = await handleCreateSend(createSendRequest({ emails: many }), h.env, OWNER_ID);
    assert.equal(tooMany.status, 400);
    // 上限数字在服务端是**字面量**（护栏不让插值），所以在这里钉一下
    const body = (await tooMany.json()) as { error?: string };
    assert.equal(body.error, `Too many email addresses (max ${SEND_EMAIL_LIST_MAX})`);
  } finally {
    h.handle.close();
  }
});

test('更新：改名单后旧码立即作废', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const accessId = seedSend(h, { emails: LISTED_EMAIL });
    await accessError(h.env, accessId, { email: LISTED_EMAIL });
    const code = lastDeliveredCode();

    const updated = await handleUpdateSend(
      new Request('https://vault.example.test/api/sends/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: `other@example.test,${LISTED_EMAIL}` }),
      }),
      h.env,
      OWNER_ID,
      SEND_ID
    );
    assert.equal(updated.status, 200);

    const stale = await accessError(h.env, accessId, { email: LISTED_EMAIL, otp: code });
    assert.equal(stale.body.send_access_error_type, 'email_and_otp_required', '名单改动后旧码必须失效');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

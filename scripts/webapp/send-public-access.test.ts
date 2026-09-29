// 公开 Send 访问链路的请求契约测试：字段名 / 端点 / 令牌用法写错时前端不会报错，
// 只会「报一个不相干的错」或下载失败，而 demo 模式（无后端）完全测不出来。
// 覆盖：① 换令牌的表单字段与 `send_access_error_type` 透传（页面靠它切界面）
// ② 用令牌取数据 / 取下载地址（**只提交一次验证码**）③ 草稿 → `authType`/`emails`/`password` 映射
// ④ 分享链接必须是「路径 + 密钥」形态（hash 写法会落到登录页）
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { buildPublicSendUrl } from '../../webapp/src/lib/app-support';
import { accessSendWithToken, createSend, requestSendAccessToken, requestSendFileUrl } from '../../webapp/src/lib/api/send';
import type { AuthedFetch } from '../../webapp/src/lib/api/shared';
import type { SendDraft, SessionState } from '../../webapp/src/lib/types';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 顶掉全局 `fetch`，记录请求并返回固定响应。 */
function stubFetch(payload: unknown, status = 200): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url: String(input),
      method: (init?.method || 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

/** 32 字节随机密钥（base64），够 `encryptBw` 当 enc/mac 用 */
function randomKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

/** 至少 16 字节的 Send 密钥材料（`hasUsableSendKey` 的下限） */
function sendKeyPart(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
}

function formOf(call: CapturedRequest): URLSearchParams {
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  return new URLSearchParams(call.body);
}

test('换令牌：POST 表单到 /identity/connect/token，字段名与官方一致', async () => {
  const calls = stubFetch({ access_token: 'tok-1', expires_in: 600, token_type: 'Bearer' });

  const token = await requestSendAccessToken('send-access-1', sendKeyPart(), { email: ' User@Example.COM ' });

  assert.equal(token, 'tok-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/identity/connect/token');
  assert.equal(calls[0].method, 'POST');
  const form = formOf(calls[0]);
  assert.equal(form.get('grant_type'), 'send_access');
  assert.equal(form.get('send_id'), 'send-access-1');
  assert.equal(form.get('client_id'), 'send');
  assert.equal(form.get('scope'), 'api.send');
  // 邮箱只做 trim，大小写交给服务端归一化（名单比对在服务端是大小写无关的）
  assert.equal(form.get('email'), 'User@Example.COM');
  assert.equal(form.get('otp'), null);
  assert.equal(form.get('password_hash_b64'), null);
});

test('换令牌：密码以 password_hash_b64 提交，随 Send 密钥材料变化', async () => {
  const keyA = sendKeyPart();
  const keyB = sendKeyPart();
  const calls = stubFetch({ access_token: 'tok-2' });

  await requestSendAccessToken('access-a', keyA, { password: 'pw-1' });
  await requestSendAccessToken('access-a', keyB, { password: 'pw-1' });
  const hashA = formOf(calls[0]).get('password_hash_b64');
  const hashB = formOf(calls[1]).get('password_hash_b64');

  assert.ok(hashA, '密码非空时必须带 password_hash_b64');
  assert.equal(Buffer.from(hashA, 'base64').length, 32);
  assert.notEqual(hashA, hashB, '哈希必须绑定该 Send 的密钥材料，不能是全局固定盐');

  // 缺密钥材料（链接没带 #key）时不提交密码 —— 让服务端按「缺凭据」返回 401
  const callsWithoutKey = stubFetch({ access_token: 'tok-3' });
  await requestSendAccessToken('access-a', null, { password: 'pw-1' });
  assert.equal(formOf(callsWithoutKey[0]).get('password_hash_b64'), null);
});

test('换令牌：验证码与邮箱一起提交（第二步）', async () => {
  const calls = stubFetch({ access_token: 'tok-4' });

  await requestSendAccessToken('access-a', null, { email: 'user@example.com', otp: '123456' });

  const form = formOf(calls[0]);
  assert.equal(form.get('email'), 'user@example.com');
  assert.equal(form.get('otp'), '123456');
});

test('换令牌：失败时把 send_access_error_type 透传给页面', async () => {
  stubFetch(
    {
      error: 'invalid_grant',
      error_description: 'Email verification code required',
      send_access_error_type: 'email_and_otp_required',
    },
    400
  );

  await assert.rejects(
    () => requestSendAccessToken('access-a', sendKeyPart(), { email: 'user@example.com' }),
    (error: Error & { status?: number; sendAccessErrorType?: string }) => {
      assert.equal(error.status, 400);
      // 页面正是靠这个字段决定显示「验证码框」还是「密码框」
      assert.equal(error.sendAccessErrorType, 'email_and_otp_required');
      assert.equal(error.message, 'Email verification code required');
      return true;
    }
  );
});

test('换令牌：响应缺 access_token 视为失败', async () => {
  stubFetch({ token_type: 'Bearer' }, 200);
  await assert.rejects(() => requestSendAccessToken('access-a', null, {}), /Failed to access send/);
});

test('用令牌取数据 / 取下载地址：只带 Bearer，不再提交验证码', async () => {
  const accessCalls = stubFetch({ id: 'send-1', type: 0 });
  await accessSendWithToken('tok-9');
  assert.equal(accessCalls[0].url, '/api/sends/access');
  assert.equal(accessCalls[0].method, 'POST');
  assert.equal(accessCalls[0].headers.authorization, 'Bearer tok-9');
  assert.equal(accessCalls[0].body, '');

  const fileCalls = stubFetch({ url: 'https://files.example/x' });
  const url = await requestSendFileUrl('tok-9', 'file-1');
  assert.equal(url, 'https://files.example/x');
  assert.equal(fileCalls[0].url, '/api/sends/access/file/file-1');
  assert.equal(fileCalls[0].method, 'POST');
  assert.equal(fileCalls[0].headers.authorization, 'Bearer tok-9');

  const missing = stubFetch({});
  await assert.rejects(() => requestSendFileUrl('tok-9', 'file-1'), /Missing file URL/);
  assert.equal(missing.length, 1);
});

/** 记录 `authedFetch` 调用并返回固定响应 */
function stubAuthedFetch(payload: unknown): { calls: CapturedRequest[]; authedFetch: AuthedFetch } {
  const calls: CapturedRequest[] = [];
  const authedFetch: AuthedFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url: input,
      method: (init?.method || 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, authedFetch };
}

const SESSION: SessionState = {
  userId: 'user-1',
  email: 'user@example.com',
  symEncKey: randomKey(),
  symMacKey: randomKey(),
  kdfIterations: 600000,
  accessToken: 'token',
  refreshToken: null,
} as unknown as SessionState;

function textDraft(overrides: Partial<SendDraft>): SendDraft {
  return {
    type: 'text',
    name: 'n',
    notes: '',
    text: 'hello',
    accessMode: 'anyone',
    password: '',
    emails: '',
    deletionDays: '7',
    expirationDays: '',
    maxAccessCount: '',
    disabled: false,
    ...overrides,
  } as SendDraft;
}

test('创建 Send：指定邮箱 → authType 0 + emails，且不带密码', async () => {
  const { calls, authedFetch } = stubAuthedFetch({ id: 'send-1' });

  // 编辑来自密码 Send 的草稿：切换成邮箱后 password 里可能还留着旧文本
  await createSend(authedFetch, SESSION, textDraft({ accessMode: 'emails', emails: 'a@b.com', password: 'leftover' }));

  const body = JSON.parse(calls[0].body) as Record<string, unknown>;
  assert.equal(body.authType, 0);
  assert.equal(body.emails, 'a@b.com');
  assert.equal(body.password, null, '邮箱认证与密码互斥，不能把旧密码一起发出去');
});

test('创建 Send：密码 → authType 1 + 密码哈希，无邮箱', async () => {
  const { calls, authedFetch } = stubAuthedFetch({ id: 'send-2' });

  await createSend(authedFetch, SESSION, textDraft({ accessMode: 'password', password: 'pw', emails: 'a@b.com' }));

  const body = JSON.parse(calls[0].body) as Record<string, unknown>;
  assert.equal(body.authType, 1);
  assert.equal(body.emails, null, '密码模式不能把残留的邮箱名单发出去');
  assert.equal(typeof body.password, 'string');
  assert.equal(Buffer.from(String(body.password), 'base64').length, 32);
});

test('创建 Send：任何人可访问 → authType 2，邮箱与密码都为空', async () => {
  const { calls, authedFetch } = stubAuthedFetch({ id: 'send-3' });

  await createSend(authedFetch, SESSION, textDraft({ accessMode: 'emails', emails: '   ' }));

  const body = JSON.parse(calls[0].body) as Record<string, unknown>;
  assert.equal(body.authType, 2, '名单为空（清空输入框）时退回「任何人可访问」');
  assert.equal(body.emails, null);
  assert.equal(body.password, null);
});

/** 去掉注释：注释里出现 `#/send` 只是说明文字，不算违规 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('分享链接一律是「路径 + 密钥」形态（`#/send/...` 路由不再解析，会落到登录页）', () => {
  assert.equal(buildPublicSendUrl('https://nw.example', 'acc-1', 'KEY-PART'), 'https://nw.example/send/acc-1/KEY-PART');

  const webappSrc = path.resolve(import.meta.dirname, '..', '..', 'webapp', 'src');
  const offenders: string[] = [];
  for (const entry of readdirSync(webappSrc, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
    if (fullPath.includes(`${path.sep}i18n${path.sep}locales${path.sep}`)) continue;
    if (/#\/send/i.test(stripComments(readFileSync(fullPath, 'utf8')))) {
      offenders.push(path.relative(webappSrc, fullPath));
    }
  }
  assert.deepEqual(offenders, [], '这些文件还在拼 hash 形态的 Send 分享链接');
});

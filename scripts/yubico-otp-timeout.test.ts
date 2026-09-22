// Yubico 外发请求的超时守卫
//
// 为什么值得测：`src/utils/yubico-otp.ts` 有**两处**外发请求，原先都没有超时。对端
// （api.yubico.com / upgrade.yubico.com）连上但不回包时，登录的二步验证与管理员启用 YubiKey 时的
// 「取 API 凭据」都会**挂住**，最后由平台兜底 500 —— 用户既进不去，也看不到原因。
//
// 加了超时之后有两条**不可退化**的语义：
//   ① 验证必须 **fail-closed**（超时 ⇒ false ⇒ 记为失败），绝不能变成"超时即通过"；
//   ② 配了多个校验地址时要**逐个尝试**，而不是卡死在第一个。
//
// 运行方式：npm run test:yubico-otp-timeout
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import type { Env } from '../src/types';
import { requestYubicoApiCredentials, verifyYubicoOtp } from '../src/utils/yubico-otp';

/** 12 位公钥 ID + modhex 余段，总长 34（合法区间 32–48） */
const OTP = 'ccccccbcgujhcbcdefghijklnrtuvcbcdef';
const CLIENT_ID = '12345';
/** base64 形态的校验密钥（Yubico 要求 base64） */
const SECRET_KEY = Buffer.from('test-secret-key-for-yubico-otp').toString('base64');
const VALIDATION_URL = 'https://api.yubico.example.test/wsapi/2.0/verify';
const GET_API_KEY_URL_HOST = 'upgrade.yubico.com';

function envWith(validationUrls: string): Env {
  return { globalSettings__yubico__validationUrls: validationUrls } as unknown as Env;
}

const CREDENTIALS = { clientId: CLIENT_ID, secretKey: SECRET_KEY };

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withFetchStub<T>(stub: FetchStub, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** 黑洞对端：连接建立、但永不回包；尊重 abort（与真实 fetch 被 abort 的行为一致）。 */
function neverResponds(): FetchStub {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
}

/**
 * 独立实现的响应签名（不调用被测代码的任何内部函数）：
 * 把除 `h` 外的字段按 key 排序拼成 `k=v&…`，再用 HMAC-SHA1(base64 密钥) 取 base64。
 */
function signResponse(fields: Record<string, string>): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('&');
  return createHmac('sha1', Buffer.from(SECRET_KEY, 'base64')).update(canonical).digest('base64');
}

test('二步验证：对端永不回包时 fail-closed（返回 false），且不会一直挂住', { timeout: 3_000 }, async () => {
  await withFetchStub(neverResponds(), async () => {
    const started = Date.now();
    const ok = await verifyYubicoOtp(envWith(VALIDATION_URL), OTP, CREDENTIALS, { requestTimeoutMs: 30 });
    assert.equal(ok, false, '超时必须判为验证失败 —— 绝不能因超时放行');
    assert.ok(Date.now() - started < 1_000, '必须在超时预算内返回，而不是挂到平台兜底');
  });
});

test('多校验地址：第一个挂住会继续试下一个，最终仍 fail-closed', { timeout: 3_000 }, async () => {
  let calls = 0;
  const stub: FetchStub = async (input, init) => {
    calls += 1;
    const url = String(input);
    if (url.includes('first.example.test')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }
    // 第二个地址立刻回一个「状态不是 OK」的响应 ⇒ 继续循环，最终 false
    return new Response('otp=1\r\nnonce=2\r\nstatus=BAD_OTP\r\n', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
  await withFetchStub(stub, async () => {
    const ok = await verifyYubicoOtp(
      envWith('https://first.example.test/wsapi/2.0/verify,https://second.example.test/wsapi/2.0/verify'),
      OTP,
      CREDENTIALS,
      { requestTimeoutMs: 30 }
    );
    assert.equal(ok, false);
    assert.equal(calls, 2, '第一个地址超时后必须继续尝试第二个');
  });
});

test('正常路径不被超时封装破坏：签名合法的 OK 响应仍然通过', async () => {
  const fields: Record<string, string> = {
    otp: OTP,
    nonce: 'abc',
    status: 'OK',
    t: '2026-09-17T00:00:00Z0000',
  };
  const stub: FetchStub = async (input) => {
    // 回显请求里的 nonce，并给出正确签名 —— 校验逻辑会检查 otp/nonce/status/h
    const requestedNonce = new URL(String(input)).searchParams.get('nonce') || '';
    const responseFields = { ...fields, nonce: requestedNonce };
    const lines = Object.entries({ ...responseFields, h: signResponse(responseFields) })
      .map(([key, value]) => `${key}=${value}`)
      .join('\r\n');
    return new Response(lines, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  };
  await withFetchStub(stub, async () => {
    const ok = await verifyYubicoOtp(envWith(VALIDATION_URL), OTP, CREDENTIALS, { requestTimeoutMs: 2_000 });
    assert.equal(ok, true, '签名校验通过时必须返回 true（超时封装不能打断正常路径）');
  });
});

test('二步验证：非法 OTP / 缺凭据仍然直接 false（回归）', async () => {
  await withFetchStub(neverResponds(), async () => {
    assert.equal(await verifyYubicoOtp(envWith(VALIDATION_URL), 'not-an-otp', CREDENTIALS), false);
    assert.equal(await verifyYubicoOtp(envWith(VALIDATION_URL), OTP, null), false);
  });
});

test('取 API 凭据：对端永不回包时返回 null（走调用方的 400 文案，而不是平台 500）', { timeout: 3_000 }, async () => {
  await withFetchStub(neverResponds(), async () => {
    const started = Date.now();
    const result = await requestYubicoApiCredentials('admin@example.test', OTP, { requestTimeoutMs: 30 });
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1_000, '必须在超时预算内返回 null');
  });
});

test('取 API 凭据：正常响应仍能解析出 clientId / secretKey（回归）', async () => {
  const stub: FetchStub = async (input) => {
    // 先解析出 host 再比对：`includes()` 对 URL 属**不完整**的校验
    // （CodeQL js/incomplete-url-substring-sanitization），任意主机名里都能塞进这段子串。
    assert.equal(new URL(String(input)).hostname, GET_API_KEY_URL_HOST, '应请求 Yubico 的 getapikey 端点');
    return new Response(
      '<table><tr><th>Client ID:</th><td><b>98765</b></td></tr><tr><th>Secret key:</th><td><code>c2VjcmV0</code></td></tr></table>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  };
  await withFetchStub(stub, async () => {
    const result = await requestYubicoApiCredentials('admin@example.test', OTP, { requestTimeoutMs: 2_000 });
    assert.deepEqual(result, { clientId: '98765', secretKey: 'c2VjcmV0' });
  });
});

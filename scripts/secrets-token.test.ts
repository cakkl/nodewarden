// 机密管理器的程序取用入口：`/identity/connect/token` 的 `scope=api.secrets` 一支。
//
// 重点三件事：
//   ① 只有「令牌 id + 密钥都对」才签发；不存在 / 密钥错 / 已吊销 / 已过期**响应完全一致**，
//      不给枚举线索
//   ② 签出的令牌**不能**用于普通端点（用途隔离靠 sub 查不到用户 + sstamp 标记双重保证）
//   ③ 成功签发会记一次 last_used_at（观测值，且写失败不得影响签发）
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleToken } from '../src/handlers/identity';
import { AuthService } from '../src/services/auth';
import type { Env } from '../src/types';
import { hashApiKey } from '../src/utils/api-key';
import { verifyJWT } from '../src/utils/jwt';
import { createSchemaDatabase, insertUser } from './lib/test-harness';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const MACHINE_ID = 'machine-1';
const TOKEN_ID = 'token-1';
const TOKEN_SECRET = 'token-secret-value';
const ENC_PAYLOAD = '2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|ccccccccccccccccccccccccccccccccccccccccccc=';
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
}

/** 建一个「已存在令牌」的库：用户 → 隐式组织 → 机器账号 → 访问令牌。 */
async function createHarness(tokenOverrides: { revokedAt?: string | null; expiresAt?: string | null } = {}): Promise<Harness> {
  const handle = await createSchemaDatabase();
  const now = '2026-01-01T00:00:00.000Z';
  insertUser(handle.connection, USER_ID);
  handle.connection
    .prepare('INSERT INTO sm_organizations(id, owner_user_id, created_at) VALUES(?, ?, ?)')
    .run(ORG_ID, USER_ID, now);
  handle.connection
    .prepare('INSERT INTO sm_machine_accounts(id, org_id, name, created_at) VALUES(?, ?, ?, ?)')
    .run(MACHINE_ID, ORG_ID, 'ci-bot', now);
  handle.connection
    .prepare(
      'INSERT INTO sm_access_tokens(id, machine_account_id, org_id, name, secret_hash, encrypted_payload, ' +
        'expires_at, revoked_at, last_used_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)'
    )
    .run(
      TOKEN_ID,
      MACHINE_ID,
      ORG_ID,
      'ci token',
      await hashApiKey(TOKEN_SECRET),
      ENC_PAYLOAD,
      tokenOverrides.expiresAt ?? null,
      tokenOverrides.revokedAt ?? null,
      now
    );
  return {
    handle,
    connection: handle.connection,
    env: { DB: handle.db, JWT_SECRET } as unknown as Env,
  };
}

/** ⚠️ 缺这个头 `handleToken` 会直接 503（不是 400），每个请求都必须带上。 */
const CLIENT_IP = '203.0.113.7';

function tokenRequest(payload: Record<string, string>): Request {
  return new Request('https://x/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': CLIENT_IP },
    body: new URLSearchParams(payload).toString(),
  });
}

function credentials(id = TOKEN_ID, secret = TOKEN_SECRET): Request {
  return tokenRequest({ grant_type: 'client_credentials', scope: 'api.secrets', client_id: id, client_secret: secret });
}

test('正确凭据：签发 Bearer 令牌并原样回吐 encrypted_payload', async () => {
  const h = await createHarness();
  try {
    const response = await handleToken(credentials(), h.env);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.scope, 'api.secrets', '响应必须带 scope');
    assert.equal(typeof body.expires_in, 'number');
    assert.ok((body.expires_in as number) > 0);
    assert.equal(body.encrypted_payload, ENC_PAYLOAD, '客户端要靠它解出组织密钥');
    assert.match(String(body.access_token), /^[\w-]+\.[\w-]+\.[\w-]+$/, '应当是 JWT');

    const lastUsed = h.connection.prepare('SELECT last_used_at FROM sm_access_tokens WHERE id = ?').get(TOKEN_ID) as {
      last_used_at: string | null;
    };
    assert.notEqual(lastUsed.last_used_at, null, '成功签发应记一次使用时间');
  } finally {
    h.handle.close();
  }
});

test('用途隔离：签出的令牌不能当普通访问令牌用', async () => {
  const h = await createHarness();
  try {
    const body = (await (await handleToken(credentials(), h.env)).json()) as { access_token: string };

    const payload = await verifyJWT(body.access_token, JWT_SECRET);
    assert.ok(payload, '签出的令牌本身应当是合法的 JWT');
    assert.equal(payload.sub, MACHINE_ID, 'sub 指向机器账号，而不是用户');
    assert.equal(payload.sstamp, 'sm.access-token', 'sstamp 是 SM 标记，永不可能等于真实 security stamp');
    assert.deepEqual(payload.scope, ['api.secrets'], 'scope 必须是数组（SDK 按数组解析）');
    assert.equal(payload.organization, ORG_ID, 'organization 是 bws 定位组织的依据');

    const verified = await new AuthService(h.env).verifyAccessTokenWithUser(`Bearer ${body.access_token}`);
    assert.equal(verified, null, '普通端点必须拒绝 SM 令牌');
  } finally {
    h.handle.close();
  }
});

test('凭据无效的四种情况响应完全一致（不给枚举线索）', async () => {
  const cases: Array<[string, () => Promise<Harness>, Request]> = [
    ['令牌不存在', () => createHarness(), credentials('no-such-token')],
    ['密钥不对', () => createHarness(), credentials(TOKEN_ID, 'wrong-secret')],
    ['已吊销', () => createHarness({ revokedAt: '2026-02-01T00:00:00.000Z' }), credentials()],
    ['已过期', () => createHarness({ expiresAt: '2000-01-01T00:00:00.000Z' }), credentials()],
  ];

  const observed: Array<{ status: number; body: unknown }> = [];
  for (const [, setup, request] of cases) {
    const h = await setup();
    try {
      const response = await handleToken(request, h.env);
      observed.push({ status: response.status, body: await response.json() });
    } finally {
      h.handle.close();
    }
  }

  for (let index = 0; index < cases.length; index += 1) {
    assert.equal(observed[index].status, 400, `${cases[index][0]}：应当 400`);
    assert.deepEqual(observed[index].body, observed[0].body, `${cases[index][0]}：响应体必须与其他情况一致`);
  }
});

test('缺参数：invalid_request（与官方 API key 登录同形）', async () => {
  const h = await createHarness();
  try {
    for (const payload of [
      { grant_type: 'client_credentials', scope: 'api.secrets', client_id: '', client_secret: TOKEN_SECRET },
      { grant_type: 'client_credentials', scope: 'api.secrets', client_id: TOKEN_ID, client_secret: '' },
    ]) {
      const response = await handleToken(tokenRequest(payload), h.env);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: string }).error, 'invalid_request');
    }
  } finally {
    h.handle.close();
  }
});

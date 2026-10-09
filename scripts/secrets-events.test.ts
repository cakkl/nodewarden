// 机密管理器的事件日志（`src/services/secrets-events.ts` + `storage-secrets-events-repo.ts`）。
//
// 重点：
//   ① ⭐ 逐条记录：批量操作产生与**成功目标数**一致的条数（照官方口径，批删 3 条 = 3 行）
//   ② 主体与归属分开：机器账号令牌 ⇒ actor=machine_account 且事件归该账号；
//      用户会话 ⇒ actor=user 且不归任何账号（所以不出现在账号日志里）
//   ③ 事件日志按**归属**取，别人的机器账号一律 404
//   ④ 官方没有码的操作（改名 / 项目授权 / 令牌增删）不记录
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleToken } from '../src/handlers/identity';
import { handleSecretsApiRoute, handleSecretsApiRouteForUser } from '../src/handlers/secrets-api';
import { handleSecretsMachineAccountRoute } from '../src/handlers/secrets-machine';
import { handleSecretsTrashRoute } from '../src/handlers/secrets';
import { ensureImplicitOrganization } from '../src/services/storage-secrets-repo';
import { createAccessToken } from '../src/services/storage-secrets-token-repo';
import type { Env } from '../src/types';
import { hashApiKey } from '../src/utils/api-key';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_A = 'user-a';
const USER_B = 'user-b';
const TOKEN_SECRET = 'client-secret-value';
const CLIENT_IP = '203.0.113.7';
/** 任意合法 EncString（type 2、三段非空）——事件测试不关心明文。 */
const ENC = '2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|ccccccccccccccccccccccccccccccccccccccccccc=';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
  orgId: string;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_A);
  insertUser(handle.connection, USER_B);
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const organization = await ensureImplicitOrganization(env.DB, USER_A);
  return { handle, connection: handle.connection, env, orgId: organization.id };
}

function jsonRequest(url: string, method: string, body?: unknown, token?: string): Request {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': CLIENT_IP,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Web 会话那侧（用户令牌闸门之后）的调用。 */
function userCall(h: Harness, userId: string, pathWithQuery: string, method: string, body?: unknown) {
  const path = pathWithQuery.split('?')[0];
  return handleSecretsApiRouteForUser(jsonRequest(`https://x${pathWithQuery}`, method, body), h.env, userId, path, method);
}

async function createProject(h: Harness, userId: string, name = ENC): Promise<string> {
  const response = await userCall(h, userId, `/api/organizations/${h.orgId}/projects`, 'POST', { name });
  assert.equal(response?.status, 200);
  return ((await response!.json()) as { id: string }).id;
}

async function createSecret(h: Harness, userId: string, projectId: string): Promise<string> {
  const response = await userCall(h, userId, `/api/organizations/${h.orgId}/secrets`, 'POST', {
    key: ENC,
    value: ENC,
    note: ENC,
    projectIds: [projectId],
  });
  assert.equal(response?.status, 200);
  return ((await response!.json()) as { id: string }).id;
}

/** 走真实流程给机器账号签发一个 SM 令牌。 */
async function issueToken(h: Harness, machineAccountId: string, tokenId: string): Promise<string> {
  await createAccessToken(h.env.DB, {
    id: tokenId,
    machineAccountId,
    orgId: h.orgId,
    name: 'ci token',
    secretHash: await hashApiKey(TOKEN_SECRET),
    encryptedPayload: ENC,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const response = await handleToken(
    new Request('https://x/identity/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': CLIENT_IP },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'api.secrets',
        client_id: tokenId,
        client_secret: TOKEN_SECRET,
      }).toString(),
    }),
    h.env
  );
  return ((await response.json()) as { access_token: string }).access_token;
}

function countEvents(h: Harness, typeCode?: number): number {
  const row = typeCode === undefined
    ? (h.connection.prepare('SELECT COUNT(*) AS n FROM sm_events').get() as { n: number })
    : (h.connection.prepare('SELECT COUNT(*) AS n FROM sm_events WHERE type_code = ?').get(typeCode) as { n: number });
  return row.n;
}

type EventRow = { actor_type: string; type_code: number; secret_id: string | null; machine_account_id: string | null };

function lastEvent(h: Harness, typeCode: number): EventRow {
  return h.connection
    .prepare('SELECT actor_type, type_code, secret_id, machine_account_id FROM sm_events WHERE type_code = ? ORDER BY rowid DESC LIMIT 1')
    .get(typeCode) as EventRow;
}

/** 取某机器账号的事件日志（走端点，顺带覆盖属主校验）。 */
async function machineEvents(h: Harness, userId: string, machineAccountId: string, query = '') {
  const path = `/api/secrets/machine-accounts/${machineAccountId}/events`;
  const response = await handleSecretsMachineAccountRoute(
    jsonRequest(`https://x${path}${query}`, 'GET'),
    h.env,
    userId,
    path,
    'GET'
  );
  assert.ok(response);
  return { status: response!.status, body: response!.status === 200 ? await response!.json() : null };
}

test('分页：一次批量操作产生的同时间戳事件也能翻页取全', async () => {
  const h = await createHarness();
  try {
    const projectId = await createProject(h, USER_A);
    const created = await handleSecretsMachineAccountRoute(
      jsonRequest('https://x/api/secrets/machine-accounts', 'POST', { name: 'ci-bot' }),
      h.env,
      USER_A,
      '/api/secrets/machine-accounts',
      'POST'
    );
    const machineId = ((await created!.json()) as { id: string }).id;
    await handleSecretsMachineAccountRoute(
      jsonRequest(`https://x/api/secrets/machine-accounts/${machineId}/grants`, 'PUT', {
        projectId,
        permission: 'read',
      }),
      h.env,
      USER_A,
      `/api/secrets/machine-accounts/${machineId}/grants`,
      'PUT'
    );
    const token = await issueToken(h, machineId, 'token-1');

    // ⭐ 一次 `get-by-ids` 取 5 条 ⇒ 5 条事件**共用同一个 `created_at`**。
    // 这正是丢记录的场景：游标只带时间的话，页边界会把这批剩下的全过滤掉。
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await createSecret(h, USER_A, projectId));
    await handleSecretsApiRoute(
      jsonRequest('https://x/api/secrets/get-by-ids', 'POST', { ids }, token),
      h.env,
      '/api/secrets/get-by-ids',
      'POST'
    );

    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = cursor
        ? `?limit=2&before=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
        : '?limit=2';
      const body = (await machineEvents(h, USER_A, machineId, query)).body as {
        data: Array<{ id: string; createdAt: string }>;
        hasMore: boolean;
      };
      seen.push(...body.data.map((event) => event.id));
      if (!body.hasMore) break;
      const last = body.data[body.data.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    assert.equal(new Set(seen).size, seen.length, '两页之间不得重复');
    // 逐页取到的集合必须等于该账号的**全部**事件（含建账号那条 2304）
    const all = (
      h.connection.prepare('SELECT id FROM sm_events WHERE machine_account_id = ?').all(machineId) as Array<{ id: string }>
    ).map((row) => row.id);
    assert.equal(all.length, 6, '5 条读取 + 1 条建账号');
    assert.deepEqual([...seen].sort(), [...all].sort(), '同时间戳的事件也必须全部翻到');
  } finally {
    h.handle.close();
  }
});

test('逐条记录：机密的新建 / 读取 / 修改 / 删除各自成条，主体是用户且不归任何账号', async () => {
  const h = await createHarness();
  try {
    const projectId = await createProject(h, USER_A);
    const secretId = await createSecret(h, USER_A, projectId);
    assert.equal(countEvents(h, 2201), 1, '建项目记 1 条');
    assert.equal(countEvents(h, 2101), 1, '建机密记 1 条');
    assert.deepEqual(
      { ...lastEvent(h, 2101) },
      { actor_type: 'user', type_code: 2101, secret_id: secretId, machine_account_id: null }
    );

    // ⭐ 逐条：一次批量取 2 条 → 2 条记录
    await createSecret(h, USER_A, projectId);
    const idsResponse = await userCall(h, USER_A, '/api/organizations/' + h.orgId + '/secrets', 'GET');
    const listed = ((await idsResponse!.json()) as { secrets: Array<{ id: string }> }).secrets;
    assert.equal(listed.length, 2);
    const byIds = await userCall(h, USER_A, '/api/secrets/get-by-ids', 'POST', { ids: listed.map((s) => s.id) });
    assert.equal(byIds?.status, 200);
    assert.equal(countEvents(h, 2100), 2, '两条机密 = 两条读取记录');

    await userCall(h, USER_A, `/api/secrets/${secretId}`, 'PUT', { key: ENC, value: ENC, note: ENC });
    assert.equal(countEvents(h, 2102), 1);

    // ⭐ 逐条：批删 2 条 → 2 条记录（不是 1 条「删了 2 条」）
    const del = await userCall(h, USER_A, '/api/secrets/delete', 'POST', listed.map((s) => s.id));
    assert.equal(del?.status, 200);
    assert.equal(countEvents(h, 2103), 2);
  } finally {
    h.handle.close();
  }
});

test('回收站：还原记 2105、永久删除记 2104，都带 secret_id', async () => {
  const h = await createHarness();
  try {
    const projectId = await createProject(h, USER_A);
    const secretId = await createSecret(h, USER_A, projectId);
    const del = await userCall(h, USER_A, '/api/secrets/delete', 'POST', [secretId]);
    assert.equal(del?.status, 200);
    assert.deepEqual(await del!.json(), { object: 'list', data: [{ id: secretId, error: null }] }, '先要真的软删成功');

    const restore = await handleSecretsTrashRoute(
      jsonRequest('https://x/api/secrets/trash/restore', 'POST', { ids: [secretId] }),
      h.env,
      USER_A,
      '/api/secrets/trash/restore',
      'POST'
    );
    assert.equal(restore?.status, 200);
    assert.deepEqual(await restore!.json(), { object: 'trashRestore', restored: [secretId] }, '还原要命中那一行');
    assert.equal(countEvents(h, 2105), 1);
    assert.equal(lastEvent(h, 2105).secret_id, secretId);

    // 还原之后再删一次：purge 只对**已在回收站**的行生效
    await userCall(h, USER_A, '/api/secrets/delete', 'POST', [secretId]);
    const purge = await handleSecretsTrashRoute(
      jsonRequest('https://x/api/secrets/trash/purge', 'POST', { ids: [secretId] }),
      h.env,
      USER_A,
      '/api/secrets/trash/purge',
      'POST'
    );
    assert.deepEqual(await purge!.json(), { object: 'trashPurge', purged: [secretId] });
    assert.equal(countEvents(h, 2104), 1);
    assert.equal(lastEvent(h, 2104).actor_type, 'user');
  } finally {
    h.handle.close();
  }
});

test('机器账号令牌读机密 ⇒ 事件归该账号；用户自己的操作不出现在账号日志里', async () => {
  const h = await createHarness();
  try {
    const projectId = await createProject(h, USER_A);
    const secretId = await createSecret(h, USER_A, projectId);

    // 建机器账号（用户操作）→ 2304，归属就是它自己
    const created = await handleSecretsMachineAccountRoute(
      jsonRequest('https://x/api/secrets/machine-accounts', 'POST', { name: 'ci-bot' }),
      h.env,
      USER_A,
      '/api/secrets/machine-accounts',
      'POST'
    );
    const machineId = ((await created!.json()) as { id: string }).id;
    assert.equal(countEvents(h, 2304), 1);
    assert.equal(lastEvent(h, 2304).machine_account_id, machineId, '建账号的事件要归到该账号');

    await handleSecretsMachineAccountRoute(
      jsonRequest(`https://x/api/secrets/machine-accounts/${machineId}/grants`, 'PUT', {
        projectId,
        permission: 'read',
      }),
      h.env,
      USER_A,
      `/api/secrets/machine-accounts/${machineId}/grants`,
      'PUT'
    );

    const token = await issueToken(h, machineId, 'token-1');
    const seen = await handleSecretsApiRoute(
      jsonRequest('https://x/api/secrets/get-by-ids', 'POST', { ids: [secretId] }, token),
      h.env,
      '/api/secrets/get-by-ids',
      'POST'
    );
    assert.equal(seen?.status, 200);

    const machineEvent = lastEvent(h, 2100);
    assert.equal(machineEvent.actor_type, 'machine_account', '令牌操作的主体是机器账号');
    assert.equal(machineEvent.machine_account_id, machineId, '事件要归到该账号');

    // 账号日志里只有属于它的事件
    const { status, body } = await machineEvents(h, USER_A, machineId);
    assert.equal(status, 200);
    const events = (body as { data: Array<{ typeCode: number }>; hasMore: boolean }).data;
    assert.deepEqual(
      events.map((event) => event.typeCode).sort(),
      [2100, 2304],
      '只有该账号的读取与它自己的创建事件（用户自己的那几条不在里面）'
    );
    assert.equal((body as { hasMore: boolean }).hasMore, false);
  } finally {
    h.handle.close();
  }
});

test('事件日志：别人的机器账号一律 404', async () => {
  const h = await createHarness();
  try {
    const created = await handleSecretsMachineAccountRoute(
      jsonRequest('https://x/api/secrets/machine-accounts', 'POST', { name: 'ci-bot' }),
      h.env,
      USER_A,
      '/api/secrets/machine-accounts',
      'POST'
    );
    const machineId = ((await created!.json()) as { id: string }).id;

    const { status } = await machineEvents(h, USER_B, machineId);
    assert.equal(status, 404);
  } finally {
    h.handle.close();
  }
});

test('分页：limit 截断并给 hasMore，before 取下一页', async () => {
  const h = await createHarness();
  try {
    const projectId = await createProject(h, USER_A);
    const created = await handleSecretsMachineAccountRoute(
      jsonRequest('https://x/api/secrets/machine-accounts', 'POST', { name: 'ci-bot' }),
      h.env,
      USER_A,
      '/api/secrets/machine-accounts',
      'POST'
    );
    const machineId = ((await created!.json()) as { id: string }).id;
    await handleSecretsMachineAccountRoute(
      jsonRequest(`https://x/api/secrets/machine-accounts/${machineId}/grants`, 'PUT', {
        projectId,
        permission: 'read',
      }),
      h.env,
      USER_A,
      `/api/secrets/machine-accounts/${machineId}/grants`,
      'PUT'
    );

    // 三次读取 → 3 条 2100（+1 条 2304）
    const token = await issueToken(h, machineId, 'token-1');
    const secretId = await createSecret(h, USER_A, projectId);
    for (let i = 0; i < 3; i += 1) {
      await handleSecretsApiRoute(
        jsonRequest('https://x/api/secrets/get-by-ids', 'POST', { ids: [secretId] }, token),
        h.env,
        '/api/secrets/get-by-ids',
        'POST'
      );
    }

    const first = await machineEvents(h, USER_A, machineId, '?limit=2');
    const firstBody = first.body as { data: Array<{ id: string; createdAt: string }>; hasMore: boolean };
    assert.equal(firstBody.data.length, 2);
    assert.equal(firstBody.hasMore, true, '还有下一页');

    const cursor = firstBody.data[1];
    const second = await machineEvents(
      h,
      USER_A,
      machineId,
      `?limit=2&before=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
    );
    const secondBody = second.body as { data: Array<{ id: string }>; hasMore: boolean };
    assert.equal(secondBody.data.length, 2, '剩下 2 条（3 次读取中的后两次；创建事件已在第一页）');
    assert.equal(secondBody.hasMore, false);
    assert.ok(
      secondBody.data.every((event) => firstBody.data.every((prev) => prev.id !== event.id)),
      '两页不重复'
    );
  } finally {
    h.handle.close();
  }
});

test('官方没有类型码的操作（改名 / 授权 / 令牌增删）不写事件', async () => {
  const h = await createHarness();
  try {
    const projectId = await createProject(h, USER_A);
    const created = await handleSecretsMachineAccountRoute(
      jsonRequest('https://x/api/secrets/machine-accounts', 'POST', { name: 'ci-bot' }),
      h.env,
      USER_A,
      '/api/secrets/machine-accounts',
      'POST'
    );
    const machineId = ((await created!.json()) as { id: string }).id;
    const before = countEvents(h);

    const call = (path: string, method: string, body?: unknown) =>
      handleSecretsMachineAccountRoute(jsonRequest(`https://x${path}`, method, body), h.env, USER_A, path, method);

    await call(`/api/secrets/machine-accounts/${machineId}`, 'PUT', { name: 'renamed' });
    await call(`/api/secrets/machine-accounts/${machineId}/grants`, 'PUT', { projectId, permission: 'read' });
    await call(`/api/secrets/machine-accounts/${machineId}/grants/${projectId}`, 'DELETE');
    await call(`/api/secrets/machine-accounts/${machineId}/tokens`, 'POST', {
      name: 'ci',
      secretHash: 'a'.repeat(64),
      encryptedPayload: ENC,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    assert.equal(countEvents(h), before, '这些操作一条事件都不该写');
  } finally {
    h.handle.close();
  }
});

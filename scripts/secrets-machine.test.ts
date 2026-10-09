// 机器账号与访问令牌的 Web 端点（`src/handlers/secrets-machine.ts`）。
//
// 重点四件事：
//   ① **横向越权（IDOR）**：拿别人的机器账号 id 做任何事都必须 404，且原数据分毫不动
//   ② **级联删除**：删机器账号要连带清掉授权与令牌（靠外键，不手写删除）
//   ③ 令牌响应**不泄漏 `secret_hash`**
//   ④ ⭐ 闭环：这里创建出来的令牌，必须能真的在换令牌端点（`scope=api.secrets`）登录成功
//   ⑤ 改名只动名字，不碰授权
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleToken } from '../src/handlers/identity';
import { handleSecretsMachineAccountRoute } from '../src/handlers/secrets-machine';
import { handleGetSecretsOrganization } from '../src/handlers/secrets';
import type { Env } from '../src/types';
import { hashApiKey } from '../src/utils/api-key';
import { createSchemaDatabase, insertUser } from './lib/test-harness';

const USER_A = 'user-a';
const USER_B = 'user-b';
const ENC = '2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|ccccccccccccccccccccccccccccccccccccccccccc=';
const TOKEN_SECRET = 'client-secret-value';
/** ⚠️ 缺这个头 `handleToken` 会直接 503（不是 400）。 */
const CLIENT_IP = '203.0.113.7';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_A);
  insertUser(handle.connection, USER_B);
  return {
    handle,
    connection: handle.connection,
    env: { DB: handle.db, JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long' } as unknown as Env,
  };
}

function jsonRequest(url: string, body: unknown, method: string): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function call(
  h: Harness,
  userId: string,
  path: string,
  method: string,
  body?: unknown
): Promise<Response | null> {
  return handleSecretsMachineAccountRoute(jsonRequest(`https://x${path}`, body, method), h.env, userId, path, method);
}

async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** A 的组织 id（由端点自己创建隐式组织）。 */
async function orgIdOf(h: Harness, userId: string): Promise<string> {
  const response = await handleGetSecretsOrganization(jsonRequest('https://x/api/secrets/organization', undefined, 'GET'), h.env, userId);
  return (await readJson<{ id: string }>(response)).id;
}

/** 建一个机器账号，返回它的 id。 */
async function createMachine(h: Harness, userId: string, name = 'ci-bot'): Promise<string> {
  const response = await call(h, userId, '/api/secrets/machine-accounts', 'POST', { name });
  assert.equal(response?.status, 200);
  return (await readJson<{ id: string }>(response as Response)).id;
}

/** 在 A 的组织里塞一个 project（授权的外键要求它真实存在）。 */
async function seedProject(h: Harness, orgId: string, id = 'project-1'): Promise<string> {
  h.connection
    .prepare(
      'INSERT INTO sm_projects(id, org_id, name_encrypted, created_at, revision_date) VALUES(?, ?, ?, ?, ?)'
    )
    .run(id, orgId, ENC, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  return id;
}

function countRows(h: Harness, table: string): number {
  return (h.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('机器账号：创建后出现在列表里，名字是明文', async () => {
  const h = await createHarness();
  try {
    const id = await createMachine(h, USER_A);
    const list = await readJson<{ data: Array<{ id: string; name: string; grants: unknown[] }> }>(
      (await call(h, USER_A, '/api/secrets/machine-accounts', 'GET')) as Response
    );
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, id);
    assert.equal(list.data[0].name, 'ci-bot');
    assert.deepEqual(list.data[0].grants, []);
  } finally {
    h.handle.close();
  }
});

test('机器账号：改名只动名字，授权不受影响；空名拒绝', async () => {
  const h = await createHarness();
  try {
    const orgA = await orgIdOf(h, USER_A);
    await seedProject(h, orgA);
    const id = await createMachine(h, USER_A, 'old-name');
    await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', { projectId: 'project-1', permission: 'write' });

    const renamed = await call(h, USER_A, `/api/secrets/machine-accounts/${id}`, 'PUT', { name: 'new-name' });
    assert.equal(renamed?.status, 200);

    const list = await readJson<{ data: Array<{ id: string; name: string; grants: Array<{ projectId: string; permission: string }> }> }>(
      (await call(h, USER_A, '/api/secrets/machine-accounts', 'GET')) as Response
    );
    assert.equal(list.data[0].name, 'new-name');
    assert.deepEqual(
      list.data[0].grants.map((grant) => ({ projectId: grant.projectId, permission: grant.permission })),
      [{ projectId: 'project-1', permission: 'write' }]
    );

    const blank = await call(h, USER_A, `/api/secrets/machine-accounts/${id}`, 'PUT', { name: '   ' });
    assert.equal(blank?.status, 400, '空名必须拒绝');
    const untouched = h.connection.prepare('SELECT name FROM sm_machine_accounts WHERE id = ?').get(id) as { name: string };
    assert.equal(untouched.name, 'new-name', '拒绝后名字不该被改');

    // 编辑时间：改名会推进 revision_date，而 created_at 不动
    h.connection
      .prepare("UPDATE sm_machine_accounts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
      .run(id);
    await call(h, USER_A, `/api/secrets/machine-accounts/${id}`, 'PUT', { name: 'later-name' });
    const stamps = h.connection
      .prepare('SELECT created_at, revision_date FROM sm_machine_accounts WHERE id = ?')
      .get(id) as { created_at: string; revision_date: string };
    assert.equal(stamps.created_at, '2026-01-01T00:00:00.000Z', '创建时间不该被改名影响');
    assert.ok(stamps.revision_date > stamps.created_at, '改名必须推进编辑时间');
  } finally {
    h.handle.close();
  }
});

test('横向越权：别人的机器账号一律 404，且原数据分毫不动', async () => {
  const h = await createHarness();
  try {
    const orgA = await orgIdOf(h, USER_A);
    await seedProject(h, orgA);
    const id = await createMachine(h, USER_A);
    await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', { projectId: 'project-1', permission: 'read' });

    // B 拿 A 的 id 做四种操作
    for (const [method, path] of [
      ['GET', `/api/secrets/machine-accounts/${id}`],
      ['PUT', `/api/secrets/machine-accounts/${id}`],
      ['DELETE', `/api/secrets/machine-accounts/${id}`],
      ['PUT', `/api/secrets/machine-accounts/${id}/grants`],
      ['GET', `/api/secrets/machine-accounts/${id}/tokens`],
    ] as const) {
      const response = await call(h, USER_B, path, method, method === 'PUT' ? { projectId: 'project-1', permission: 'write' } : undefined);
      assert.equal(response?.status, 404, `${method} ${path} 必须 404`);
    }

    assert.equal(countRows(h, 'sm_machine_accounts'), 1, '账号不该被删掉');
    assert.equal(countRows(h, 'sm_machine_account_projects'), 1, '授权不该被改动');
    const grant = h.connection
      .prepare('SELECT permission FROM sm_machine_account_projects WHERE machine_account_id = ?')
      .get(id) as { permission: string };
    assert.equal(grant.permission, 'read', '权限不该被 B 改成 write');
  } finally {
    h.handle.close();
  }
});

test('授权：同一 (账号, project) 重复设置是改档，不是新增行；项目不存在则 404', async () => {
  const h = await createHarness();
  try {
    const orgA = await orgIdOf(h, USER_A);
    await seedProject(h, orgA);
    const id = await createMachine(h, USER_A);

    await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', { projectId: 'project-1', permission: 'read' });
    await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', { projectId: 'project-1', permission: 'write' });

    assert.equal(countRows(h, 'sm_machine_account_projects'), 1, '不该写成两行');
    const grant = h.connection
      .prepare('SELECT permission FROM sm_machine_account_projects WHERE machine_account_id = ?')
      .get(id) as { permission: string };
    assert.equal(grant.permission, 'write');

    const bogus = await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', {
      projectId: 'no-such-project',
      permission: 'read',
    });
    assert.equal(bogus?.status, 404, '引用不存在的 project 应当是 404，而不是外键 500');

    const bad = await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', {
      projectId: 'project-1',
      permission: 'admin',
    });
    assert.equal(bad?.status, 400, '只允许 read / write 两档');

    const removed = await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants/project-1`, 'DELETE');
    assert.equal(removed?.status, 200);
    assert.equal(countRows(h, 'sm_machine_account_projects'), 0);
  } finally {
    h.handle.close();
  }
});

test('令牌：创建只回 id、列表不泄漏 secret_hash，吊销后 revoked_at 非空', async () => {
  const h = await createHarness();
  try {
    const id = await createMachine(h, USER_A);
    const created = await call(h, USER_A, `/api/secrets/machine-accounts/${id}/tokens`, 'POST', {
      name: 'ci token',
      secretHash: await hashApiKey(TOKEN_SECRET),
      encryptedPayload: ENC,
    });
    assert.equal(created?.status, 200);
    const createdBody = await readJson(created as Response);
    assert.equal(typeof createdBody.id, 'string');
    assert.equal('secretHash' in createdBody, false, '创建响应不该回吐哈希');
    assert.equal('encryptedPayload' in createdBody, false, '创建响应不该回吐载荷');

    const list = await call(h, USER_A, `/api/secrets/machine-accounts/${id}/tokens`, 'GET');
    const listed = await readJson<{ data: Array<Record<string, unknown>> }>(list as Response);
    assert.equal(listed.data.length, 1);
    assert.equal('secretHash' in listed.data[0], false, '列表不得泄漏哈希');
    assert.equal(listed.data[0].revokedAt, null);

    const revoked = await call(h, USER_A, `/api/secrets/tokens/${String(createdBody.id)}`, 'DELETE');
    assert.equal(revoked?.status, 200);
    const row = h.connection.prepare('SELECT revoked_at FROM sm_access_tokens WHERE id = ?').get(String(createdBody.id)) as {
      revoked_at: string | null;
    };
    assert.notEqual(row.revoked_at, null);
  } finally {
    h.handle.close();
  }
});

test('闭环：这里创建的令牌能直接在换令牌端点登录成功', async () => {
  const h = await createHarness();
  try {
    const machineId = await createMachine(h, USER_A);
    const created = await readJson<{ id: string }>(
      (await call(h, USER_A, `/api/secrets/machine-accounts/${machineId}/tokens`, 'POST', {
        name: 'ci token',
        secretHash: await hashApiKey(TOKEN_SECRET),
        encryptedPayload: ENC,
      })) as Response
    );

    // 客户端拿到的令牌是 `0.<id>.<secret>:<key>`；取用端只用到后两段的语义
    const login = await handleToken(
      new Request('https://x/identity/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': CLIENT_IP },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'api.secrets',
          client_id: created.id,
          client_secret: TOKEN_SECRET,
        }).toString(),
      }),
      h.env
    );
    assert.equal(login.status, 200);
    const body = await readJson(login);
    assert.equal(body.encrypted_payload, ENC, '登录要原样回吐载荷');
    assert.equal(body.scope, 'api.secrets');
  } finally {
    h.handle.close();
  }
});

test('级联删除：删机器账号会一并清掉授权与令牌', async () => {
  const h = await createHarness();
  try {
    const orgA = await orgIdOf(h, USER_A);
    await seedProject(h, orgA);
    const id = await createMachine(h, USER_A);
    await call(h, USER_A, `/api/secrets/machine-accounts/${id}/grants`, 'PUT', { projectId: 'project-1', permission: 'read' });
    await call(h, USER_A, `/api/secrets/machine-accounts/${id}/tokens`, 'POST', {
      name: 'ci token',
      secretHash: await hashApiKey(TOKEN_SECRET),
      encryptedPayload: ENC,
    });
    assert.equal(countRows(h, 'sm_access_tokens'), 1);

    const removed = await call(h, USER_A, `/api/secrets/machine-accounts/${id}`, 'DELETE');
    assert.equal(removed?.status, 200);
    assert.equal(countRows(h, 'sm_machine_accounts'), 0);
    assert.equal(countRows(h, 'sm_machine_account_projects'), 0, '授权应随外键级联清掉');
    assert.equal(countRows(h, 'sm_access_tokens'), 0, '令牌应随外键级联清掉（否则会留下能用的凭据）');
  } finally {
    h.handle.close();
  }
});

test('入参校验：缺 name / 哈希格式不对 / 时间格式不对都拒绝', async () => {
  const h = await createHarness();
  try {
    const id = await createMachine(h, USER_A);
    const badBodies: Array<Record<string, unknown>> = [
      { secretHash: await hashApiKey(TOKEN_SECRET), encryptedPayload: ENC },
      { name: 't', secretHash: 'plain-text', encryptedPayload: ENC },
      { name: 't', secretHash: await hashApiKey(TOKEN_SECRET), encryptedPayload: 'not-an-encstring' },
      { name: 't', secretHash: await hashApiKey(TOKEN_SECRET), encryptedPayload: ENC, expiresAt: 'not-a-date' },
    ];
    for (const body of badBodies) {
      const response = await call(h, USER_A, `/api/secrets/machine-accounts/${id}/tokens`, 'POST', body);
      assert.equal(response?.status, 400, `应当拒绝：${JSON.stringify(body)}`);
    }

    const noName = await call(h, USER_A, '/api/secrets/machine-accounts', 'POST', { name: '   ' });
    assert.equal(noName?.status, 400);
  } finally {
    h.handle.close();
  }
});

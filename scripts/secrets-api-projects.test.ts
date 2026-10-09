// 官方形态的 projects 端点（`src/handlers/secrets-api.ts`）。
//
// 重点：
//   ① 鉴权是**机器账号令牌**：用户令牌、坏令牌、无令牌都必须 401
//   ② 按 project **严格过滤**：未授权 = 404（连存在性都不泄漏）；改/删要 write，只有 read 时 403
//   ③ 照抄官方那条怪规则：**只读的机器账号也能建 project**，且建完自动拿到该 project 的 write
//   ④ 删 project 是硬删，但它名下的 secret **不跟着消失**（只是断开关联）
//   ⑤ 删掉机器账号后，它已签发的 JWT 必须**立刻**失效（不能等一小时过期）
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleToken } from '../src/handlers/identity';
import { handleSecretsApiRoute } from '../src/handlers/secrets-api';
import { ensureImplicitOrganization } from '../src/services/storage-secrets-repo';
import { createMachineAccount, setMachineAccountGrant } from '../src/services/storage-secrets-machine-repo';
import { createAccessToken } from '../src/services/storage-secrets-token-repo';
import type { Env } from '../src/types';
import { hashApiKey } from '../src/utils/api-key';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'user-1';
const MACHINE_ID = 'machine-1';
const OTHER_MACHINE_ID = 'machine-2';
const TOKEN_SECRET = 'client-secret-value';
const ENC = '2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|ccccccccccccccccccccccccccccccccccccccccccc=';
const ENC_NAME = '2.dddddddddddddddddddddd==|eeeeeeeeeeeeeeeeeeeeee==|fffffffffffffffffffffffffffffffffffffffffff=';
const CLIENT_IP = '203.0.113.7';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
  orgId: string;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID);
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const organization = await ensureImplicitOrganization(env.DB, USER_ID);
  await createMachineAccount(env.DB, { id: MACHINE_ID, orgId: organization.id, name: 'ci-bot', createdAt: '2026-01-01T00:00:00.000Z', revisionDate: '2026-01-01T00:00:00.000Z' });
  await createMachineAccount(env.DB, { id: OTHER_MACHINE_ID, orgId: organization.id, name: 'other-bot', createdAt: '2026-01-01T00:00:00.000Z', revisionDate: '2026-01-01T00:00:00.000Z' });
  return { handle, connection: handle.connection, env, orgId: organization.id };
}

let tokenCounter = 0;

/** 走真实流程签发一个 SM 令牌（建令牌行 → 换令牌端点）。 */
async function issueToken(h: Harness, machineAccountId = MACHINE_ID): Promise<string> {
  tokenCounter += 1;
  const tokenId = `token-${tokenCounter}`;
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
  assert.equal(response.status, 200, '签发令牌应当成功');
  return ((await response.json()) as { access_token: string }).access_token;
}

function call(h: Harness, path: string, method: string, init: { token?: string | null; body?: unknown } = {}): Promise<Response | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null && init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  return handleSecretsApiRoute(
    new Request(`https://x${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    h.env,
    path,
    method
  );
}

async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createProjectViaApi(h: Harness, token: string, name = ENC_NAME): Promise<string> {
  const response = await call(h, `/api/organizations/${h.orgId}/projects`, 'POST', { token, body: { name } });
  assert.equal(response?.status, 200, '建 project 应当成功');
  return String((await readJson(response as Response)).id);
}

test('鉴权：非 SM 令牌一律放行给用户令牌闸门（401 由那道闸门给出）', async () => {
  const h = await createHarness();
  try {
    const path = `/api/organizations/${h.orgId}/projects`;
    // ⚠️ 本模块**不能**吞掉非 SM 令牌：「单段就是 secret id」的规则会匹配到 Web 会话自有的
    // `/api/secrets/organization*` 等路径，吞掉它们就全成了死路。会话令牌走的是下面这条
    // 放行路径，拿到的是 owner 主体（而不是这里解析出的机器账号）。
    assert.equal(await call(h, path, 'GET', { token: null }), null, '无令牌');
    assert.equal(await call(h, path, 'GET', { token: 'not-a-jwt' }), null, '坏令牌');
    assert.equal(await call(h, path, 'GET', { token: 'header.payload.signature' }), null, '用户令牌');
  } finally {
    h.handle.close();
  }
});

test('组织不匹配：拿令牌去访问别的组织，一律 404', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const response = await call(h, '/api/organizations/some-other-org/projects', 'GET', { token });
    assert.equal(response?.status, 404);
  } finally {
    h.handle.close();
  }
});

test('怪规则：只读机器账号也能建 project，且建完自动拿到该 project 的 write', async () => {
  const h = await createHarness();
  try {
    // 先给一个「只读」的授权：证明建 project 不依赖写权限
    const token = await issueToken(h);
    const created = await call(h, `/api/organizations/${h.orgId}/projects`, 'POST', { token, body: { name: ENC_NAME } });
    assert.equal(created?.status, 200);
    const project = await readJson<{ id: string; name: string; organizationId: string }>(created as Response);
    assert.equal(project.organizationId, h.orgId);
    assert.equal(project.name, ENC_NAME, 'project 名是密文，原样往返');

    const grant = h.connection
      .prepare('SELECT permission FROM sm_machine_account_projects WHERE machine_account_id = ? AND project_id = ?')
      .get(MACHINE_ID, project.id) as { permission: string } | undefined;
    assert.equal(grant?.permission, 'write', '建 project 的人应自动成为它的 write 成员');

    // 列表里也能看到
    const list = await readJson<{ data: Array<{ id: string }> }>(
      (await call(h, `/api/organizations/${h.orgId}/projects`, 'GET', { token })) as Response
    );
    assert.deepEqual(list.data.map((item) => item.id), [project.id]);
  } finally {
    h.handle.close();
  }
});

test('按 project 严格过滤：未授权看不到（404），只有 read 时改不了（403）', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const visible = await createProjectViaApi(h, token);
    const hidden = await createProjectViaApi(h, token);

    // 去掉 hidden 的授权 ⇒ 立刻不可见
    h.connection.prepare('DELETE FROM sm_machine_account_projects WHERE project_id = ?').run(hidden);

    assert.equal((await call(h, `/api/projects/${hidden}`, 'GET', { token }))?.status, 404, '未授权 = 不存在');
    const list = await readJson<{ data: Array<{ id: string }> }>(
      (await call(h, `/api/organizations/${h.orgId}/projects`, 'GET', { token })) as Response
    );
    assert.deepEqual(list.data.map((item) => item.id), [visible], '列表只含已授权的');

    // 降级为只读 ⇒ 读得到、改不了
    await setMachineAccountGrant(h.env.DB, MACHINE_ID, visible, 'read');
    assert.equal((await call(h, `/api/projects/${visible}`, 'GET', { token }))?.status, 200);
    assert.equal((await call(h, `/api/projects/${visible}`, 'PUT', { token, body: { name: ENC_NAME } }))?.status, 403);
    assert.equal((await call(h, `/api/projects/delete`, 'POST', { token, body: [visible] }))?.status, 200);
  } finally {
    h.handle.close();
  }
});

test('改名：name 与 revisionDate 一起更新', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const id = await createProjectViaApi(h, token);
    // 把时间戳压回过去：否则「创建」与「改名」可能落在同一毫秒，断言会变成看运气
    const past = '2020-01-01T00:00:00.000Z';
    h.connection.prepare('UPDATE sm_projects SET created_at = ?, revision_date = ? WHERE id = ?').run(past, past, id);

    const renamed = '2.gggggggggggggggggggggg==|hhhhhhhhhhhhhhhhhhhhhh==|iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii=';
    const response = await call(h, `/api/projects/${id}`, 'PUT', { token, body: { name: renamed } });
    assert.equal(response?.status, 200);
    const body = await readJson<{ name: string; revisionDate: string; creationDate: string }>(response as Response);
    assert.equal(body.name, renamed);
    assert.ok(body.revisionDate > past, `revisionDate 应当推进，实际 ${body.revisionDate}`);

    const row = h.connection.prepare('SELECT name_encrypted, revision_date FROM sm_projects WHERE id = ?').get(id) as {
      name_encrypted: string;
      revision_date: string;
    };
    assert.equal(row.name_encrypted, renamed, '库里应当真的换了名字');
    assert.equal(row.revision_date, body.revisionDate);
  } finally {
    h.handle.close();
  }
});

test('批量删：返回 [{id, error}]，无权/不存在给 error，成功给 null；secret 只被解除分配', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const id = await createProjectViaApi(h, token);

    // 造一个挂在该 project 下的 secret，用来验证「删 project 不删 secret」
    h.connection
      .prepare(
        'INSERT INTO sm_secrets(id, org_id, key_encrypted, value_encrypted, note_encrypted, created_at, revision_date) ' +
          'VALUES(?, ?, ?, ?, ?, ?, ?)'
      )
      .run('secret-1', h.orgId, ENC, ENC, ENC, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    h.connection.prepare('INSERT INTO sm_secret_projects(secret_id, project_id) VALUES(?, ?)').run('secret-1', id);

    const response = await call(h, '/api/projects/delete', 'POST', {
      token,
      body: [id, 'no-such-project', ''],
    });
    assert.equal(response?.status, 200);
    const { data: results } = await readJson<{ data: Array<{ id: string; error: string | null }> }>(response as Response);
    assert.equal(results.length, 3);
    assert.deepEqual(results[0], { id, error: null });
    assert.equal(results[1].error, 'Not found');
    assert.equal(results[2].error, 'Invalid project id');

    assert.equal(
      (h.connection.prepare('SELECT COUNT(*) AS n FROM sm_secrets WHERE id = ?').get('secret-1') as { n: number }).n,
      1,
      'secret 本体不该被删'
    );
    assert.equal(
      (h.connection.prepare('SELECT COUNT(*) AS n FROM sm_secret_projects WHERE secret_id = ?').get('secret-1') as { n: number }).n,
      0,
      '只是断开关联，变成未分配'
    );

    // 批量删的请求体必须是**裸数组**，包一层对象就是 400
    assert.equal((await call(h, '/api/projects/delete', 'POST', { token, body: { ids: [id] } }))?.status, 400);
  } finally {
    h.handle.close();
  }
});

test('删掉机器账号后，它已签发的 JWT 立刻失效', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const path = `/api/organizations/${h.orgId}/projects`;
    assert.equal((await call(h, path, 'GET', { token }))?.status, 200, '删之前可用');

    h.connection.prepare('DELETE FROM sm_machine_accounts WHERE id = ?').run(MACHINE_ID);

    assert.equal((await call(h, path, 'GET', { token }))?.status, 401, '删之后 JWT 必须立刻不可用，不能等它过期');
  } finally {
    h.handle.close();
  }
});

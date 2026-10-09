// 官方形态的 secrets 端点（`src/handlers/secrets-api.ts`）。
//
// 重点：
//   ① ⭐ 列表**不含 value / note**（官方契约：值走 `get-by-ids`），且内层 `projects[]` 要填完整
//   ② `get-by-ids` 对不可见的 id **静默跳过**，不报错（否则就是存在性探针）
//   ③ 权限：不可见 404、可见但只读 403、可写才允改删
//   ④ 删是**软删**（进 Trash），不是物理删除
//   ⑤ ⭐ 多对多：一个 secret 挂两个 project，删掉其中一个之后仍通过另一个可见
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
const TOKEN_SECRET = 'client-secret-value';
const ENC_KEY = '2.kkkkkkkkkkkkkkkkkkkkkk==|llllllllllllllllllllll==|mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm=';
const ENC_VALUE = '2.vvvvvvvvvvvvvvvvvvvvvv==|wwwwwwwwwwwwwwwwwwwwww==|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=';
const ENC_NAME = '2.nnnnnnnnnnnnnnnnnnnnnn==|oooooooooooooooooooooo==|ppppppppppppppppppppppppppppppppppppppppppp=';
/** 「没有备注」也要发空串的密文（官方客户端就是这么做的，服务端会拒绝裸空串）。 */
const ENC_NOTE = '2.yyyyyyyyyyyyyyyyyyyyyy==|zzzzzzzzzzzzzzzzzzzzzz==|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=';
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
  await createMachineAccount(env.DB, {
    id: MACHINE_ID,
    orgId: organization.id,
    name: 'ci-bot',
    createdAt: '2026-01-01T00:00:00.000Z',
    revisionDate: '2026-01-01T00:00:00.000Z',
  });
  return { handle, connection: handle.connection, env, orgId: organization.id };
}

let tokenCounter = 0;

async function issueToken(h: Harness): Promise<string> {
  tokenCounter += 1;
  const tokenId = `token-${tokenCounter}`;
  await createAccessToken(h.env.DB, {
    id: tokenId,
    machineAccountId: MACHINE_ID,
    orgId: h.orgId,
    name: 'ci token',
    secretHash: await hashApiKey(TOKEN_SECRET),
    encryptedPayload: ENC_KEY,
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

function call(h: Harness, pathWithQuery: string, method: string, token: string, body?: unknown): Promise<Response | null> {
  // ⚠️ 真实 router 传给 handler 的 path **不含查询串**，这里保持一致（否则带 ?lastSyncedDate= 的
  // 路径会因为 `$` 锚定而匹配不上）
  const path = pathWithQuery.split('?')[0];
  return handleSecretsApiRoute(
    new Request(`https://x${pathWithQuery}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    h.env,
    path,
    method
  );
}

async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createProject(h: Harness, token: string, name = ENC_NAME): Promise<string> {
  const response = await call(h, `/api/organizations/${h.orgId}/projects`, 'POST', token, { name });
  assert.equal(response?.status, 200);
  return String((await readJson(response as Response)).id);
}

async function createSecret(h: Harness, token: string, projectIds: string[]): Promise<string> {
  const response = await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', token, {
    key: ENC_KEY,
    value: ENC_VALUE,
    note: ENC_NOTE,
    projectIds,
  });
  assert.equal(response?.status, 200, '建 secret 应当成功');
  return String((await readJson(response as Response)).id);
}

test('创建：列表不含 value/note，但详情有', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const projectId = await createProject(h, token);

    // 引用不存在的 project ⇒ 400
    const bogus = await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', token, {
      key: ENC_KEY,
      value: ENC_VALUE,
      note: ENC_NOTE,
      projectIds: ['no-such-project'],
    });
    assert.equal(bogus?.status, 400);

    // 裸空串备注 ⇒ 400：官方客户端会把每个 secret 的 note 当 EncString 解析，存进去会让整列报错
    const bareNote = await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', token, {
      key: ENC_KEY,
      value: ENC_VALUE,
      note: '',
      projectIds: [projectId],
    });
    assert.equal(bareNote?.status, 400);

    const id = await createSecret(h, token, [projectId]);

    const list = await readJson<{ object: string; secrets: Array<Record<string, unknown>>; projects: Array<{ id: string }> }>(
      (await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET', token)) as Response
    );
    assert.equal(list.object, 'list');
    assert.equal(list.secrets.length, 1);
    assert.equal(list.secrets[0].key, ENC_KEY);
    assert.equal('value' in list.secrets[0], false, '列表不得含 value');
    assert.equal('note' in list.secrets[0], false, '列表不得含 note');
    // ⭐ 内层 projects[] 必须填（SDK 读内层）
    assert.equal((list.secrets[0].projects as Array<{ id: string }>)[0].id, projectId);
    assert.equal(list.projects[0].id, projectId);

    const detail = await readJson((await call(h, `/api/secrets/${id}`, 'GET', token)) as Response);
    assert.equal(detail.value, ENC_VALUE);
    assert.equal(detail.key, ENC_KEY);
  } finally {
    h.handle.close();
  }
});

test('未分配：允许一个 project 都不选，但机器账号看不到它', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);

    // 一个 project 都不选是**允许**的（官方 `project_ids` 同样可选）
    const response = await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', token, {
      key: ENC_KEY,
      value: ENC_VALUE,
      note: ENC_NOTE,
      projectIds: [],
    });
    assert.equal(response?.status, 200, '未分配机密应当能建');
    const body = await readJson<{ id: string; projects: unknown[] }>(response as Response);
    assert.deepEqual(body.projects, [], '不带任何 project');

    // ⚠️ 机器账号的可见性**完全**按 project 授权过滤 ⇒ 未分配机密对它不可见
    // （连刚建它的这个账号也一样看不到）
    assert.equal((await call(h, `/api/secrets/${body.id}`, 'GET', token))?.status, 404);
    const listed = await readJson<{ secrets: unknown[] }>(
      (await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET', token)) as Response
    );
    assert.equal(listed.secrets.length, 0, '列表里没有它');
    // 「owner（Web 会话）看得到」见 `secrets-api-web-session.test.ts`
  } finally {
    h.handle.close();
  }
});

test('写权限：只读的机器账号不能把 secret 建进 / 挪进未授权的 project', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const mine = await createProject(h, token);
    const foreign = await createProject(h, token);
    // 建 project 时会自动拿到 write ⇒ 显式退回只读；另一个彻底撤掉授权
    await setMachineAccountGrant(h.env.DB, MACHINE_ID, mine, 'read');
    h.connection.prepare('DELETE FROM sm_machine_account_projects WHERE project_id = ?').run(foreign);

    const createIn = async (projectIds: string[]): Promise<number | undefined> =>
      (
        await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', token, {
          key: ENC_KEY,
          value: ENC_VALUE,
          note: ENC_NOTE,
          projectIds,
        })
      )?.status;

    // ⭐ 未授权的 project：不得写入（否则那条 secret 立刻对该 project 的持有者可见）
    assert.equal(await createIn([foreign]), 400, '不能建进未授权的 project');
    // 只读的 project：建 secret 要求 write
    assert.equal(await createIn([mine]), 400, '只读的 project 不能建 secret');

    await setMachineAccountGrant(h.env.DB, MACHINE_ID, mine, 'write');
    assert.equal(await createIn([mine]), 200, '有 write 才放行');

    // 改已有 secret 的归属：同样不许挪进未授权的 project
    const id = await createSecret(h, token, [mine]);
    const moved = await call(h, `/api/secrets/${id}`, 'PUT', token, {
      key: ENC_KEY,
      value: ENC_VALUE,
      note: ENC_NOTE,
      projectIds: [foreign],
    });
    assert.equal(moved?.status, 400, '不能把 secret 挪进未授权的 project');
  } finally {
    h.handle.close();
  }
});

test('畸形 EncString 一律 400：形状对但长度不对的也要挡掉', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const projectId = await createProject(h, token);
    const path = `/api/organizations/${h.orgId}/secrets`;

    const postKey = async (cipher: string): Promise<number | undefined> => {
      const response = await call(h, path, 'POST', token, {
        key: cipher,
        value: ENC_VALUE,
        note: ENC_NOTE,
        projectIds: [projectId],
      });
      return response?.status;
    };

    const iv16 = `${'a'.repeat(22)}==`;
    const ct16 = `${'b'.repeat(22)}==`;
    const mac32 = `${'c'.repeat(43)}=`;

    // ⭐ 这就是那次事故的形状：MAC 只有 16 字节。存进去会让官方客户端**整个列表**读不出来
    // （`Invalid length: expected 32, got 16`），所以必须在写入时就拒。
    assert.equal(await postKey(`2.${iv16}|${ct16}|${'c'.repeat(22)}==`), 400, 'MAC 必须是 32 字节');
    assert.equal(await postKey(`2.${'a'.repeat(11)}=|${ct16}|${mac32}`), 400, 'iv 必须是 16 字节');
    assert.equal(await postKey(`2.${iv16}|${'b'.repeat(11)}=|${mac32}`), 400, 'ct 必须是 16 字节的整数倍');
    assert.equal(await postKey('not-a-cipher'), 400);
    // 基线：长度全对就应当通过（否则上面三条可能是被别的原因拒掉的）
    assert.equal(await postKey(`2.${iv16}|${ct16}|${mac32}`), 200);
  } finally {
    h.handle.close();
  }
});

test('get-by-ids：给出值；不可见的 id 静默跳过', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const projectId = await createProject(h, token);
    const id = await createSecret(h, token, [projectId]);

    const response = await call(h, '/api/secrets/get-by-ids', 'POST', token, { ids: [id, 'not-a-real-secret'] });
    assert.equal(response?.status, 200);
    const body = await readJson<{ data: Array<{ id: string; value: string }> }>(response as Response);
    assert.equal(body.data.length, 1, '不存在的 id 应被跳过，而不是报错');
    assert.equal(body.data[0].id, id);
    assert.equal(body.data[0].value, ENC_VALUE);

    assert.equal((await call(h, '/api/secrets/get-by-ids', 'POST', token, { ids: 'nope' }))?.status, 400);
  } finally {
    h.handle.close();
  }
});

test('权限：不可见 404、可见但只读 403；软删后列表与 get-by-ids 都不再给', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const projectId = await createProject(h, token);
    const id = await createSecret(h, token, [projectId]);

    // 降级为只读：读得到、改不了
    await setMachineAccountGrant(h.env.DB, MACHINE_ID, projectId, 'read');
    assert.equal((await call(h, `/api/secrets/${id}`, 'GET', token))?.status, 200);
    assert.equal((await call(h, `/api/secrets/${id}`, 'PUT', token, { key: ENC_KEY, value: ENC_VALUE, note: ENC_NOTE }))?.status, 403);
    const readOnlyDelete = await readJson<{ data: Array<{ id: string; error: string | null }> }>(
      (await call(h, '/api/secrets/delete', 'POST', token, [id])) as Response
    );
    assert.equal(readOnlyDelete.data[0].error, 'Forbidden');

    // 撤销授权 ⇒ 彻底不可见
    h.connection.prepare('DELETE FROM sm_machine_account_projects WHERE project_id = ?').run(projectId);
    assert.equal((await call(h, `/api/secrets/${id}`, 'GET', token))?.status, 404);
    const invisibleDelete = await readJson<{ data: Array<{ id: string; error: string | null }> }>(
      (await call(h, '/api/secrets/delete', 'POST', token, [id])) as Response
    );
    assert.equal(invisibleDelete.data[0].error, 'Not found');

    // 恢复写权限后软删
    await setMachineAccountGrant(h.env.DB, MACHINE_ID, projectId, 'write');
    const removed = await readJson<{ object: string; data: Array<{ id: string; error: string | null }> }>(
      (await call(h, '/api/secrets/delete', 'POST', token, [id])) as Response
    );
    assert.deepEqual(removed, { object: 'list', data: [{ id, error: null }] });

    const row = h.connection.prepare('SELECT deleted_at FROM sm_secrets WHERE id = ?').get(id) as {
      deleted_at: string | null;
    };
    assert.notEqual(row.deleted_at, null, '应当是软删（进 Trash），不是物理删除');

    const list = await readJson<{ secrets: unknown[] }>(
      (await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET', token)) as Response
    );
    assert.equal(list.secrets.length, 0);

    const byIds = await readJson<{ data: unknown[] }>(
      (await call(h, '/api/secrets/get-by-ids', 'POST', token, { ids: [id] })) as Response
    );
    assert.equal(byIds.data.length, 0, '已进 Trash 的不再返回');
  } finally {
    h.handle.close();
  }
});

test('多对多：一个 secret 挂两个 project，删掉一个仍能看到，删光才不可见', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const first = await createProject(h, token);
    const second = await createProject(h, token);
    const id = await createSecret(h, token, [first, second]);

    const idsOf = async (): Promise<string[]> => {
      const response = await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET', token);
      const body = await readJson<{ secrets: Array<{ id: string; projects: Array<{ id: string }> }> }>(response as Response);
      return body.secrets.find((secret) => secret.id === id)?.projects.map((project) => project.id) ?? [];
    };
    // 关联顺序由响应决定，不应当被断言依赖 ⇒ 比较排序后的集合
    assert.deepEqual([...(await idsOf())].sort(), [first, second].sort());

    // 删掉其中一个 project：关联少一条，secret 仍在
    await call(h, '/api/projects/delete', 'POST', token, [first]);
    assert.deepEqual(await idsOf(), [second]);
    assert.equal((await call(h, `/api/secrets/${id}`, 'GET', token))?.status, 200);

    // 再删另一个 ⇒ secret 变成未分配，对程序侧不可见，但本体还在库里
    await call(h, '/api/projects/delete', 'POST', token, [second]);
    assert.equal((await call(h, `/api/secrets/${id}`, 'GET', token))?.status, 404);
    assert.equal(
      (h.connection.prepare('SELECT COUNT(*) AS n FROM sm_secrets WHERE id = ?').get(id) as { n: number }).n,
      1,
      'secret 本体不该被删'
    );
  } finally {
    h.handle.close();
  }
});

test('更新：projectIds 缺省不改关联；给了就整体替换，给空数组则清空', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const first = await createProject(h, token);
    const second = await createProject(h, token);
    const id = await createSecret(h, token, [first]);

    const renamed = '2.rrrrrrrrrrrrrrrrrrrrrr==|ssssssssssssssssssssss==|ttttttttttttttttttttttttttttttttttttttttttt=';
    const noProjectIds = await readJson<{ key: string; projects: Array<{ id: string }> }>(
      (await call(h, `/api/secrets/${id}`, 'PUT', token, { key: renamed, value: ENC_VALUE, note: ENC_NOTE })) as Response
    );
    assert.equal(noProjectIds.key, renamed);
    assert.deepEqual(noProjectIds.projects.map((project) => project.id), [first], '缺省 projectIds 不该动关联');

    const replaced = await readJson<{ projects: Array<{ id: string }> }>(
      (await call(h, `/api/secrets/${id}`, 'PUT', token, {
        key: renamed,
        value: ENC_VALUE,
        note: ENC_NOTE,
        projectIds: [second],
      })) as Response
    );
    assert.deepEqual(replaced.projects.map((project) => project.id), [second]);

    // 显式 `[]` = 清空 ⇒ 变成「未分配」
    const cleared = await readJson<{ projects: Array<{ id: string }> }>(
      (await call(h, `/api/secrets/${id}`, 'PUT', token, {
        key: renamed,
        value: ENC_VALUE,
        note: ENC_NOTE,
        projectIds: [],
      })) as Response
    );
    assert.deepEqual(cleared.projects, [], '显式空数组应当清空关联');
    assert.equal(
      (h.connection.prepare('SELECT COUNT(*) AS n FROM sm_secret_projects WHERE secret_id = ?').get(id) as { n: number })
        .n,
      0,
      '关联行应当被删掉'
    );
  } finally {
    h.handle.close();
  }
});

test('同步：lastSyncedDate 可省、必须合法；secrets 是列表信封且元素带值', async () => {
  const h = await createHarness();
  try {
    const token = await issueToken(h);
    const projectId = await createProject(h, token);
    const id = await createSecret(h, token, [projectId]);
    const path = `/api/organizations/${h.orgId}/secrets/sync`;

    assert.equal((await call(h, `${path}?lastSyncedDate=not-a-date`, 'GET', token))?.status, 400);

    type SyncBody = {
      hasChanges: boolean;
      secrets?: { data: Array<{ id: string; value: string; note: string }> };
    };

    const all = await readJson<SyncBody>(
      (await call(h, `${path}?lastSyncedDate=2000-01-01T00:00:00.000Z`, 'GET', token)) as Response
    );
    assert.equal(all.hasChanges, true);
    assert.deepEqual(all.secrets?.data.map((secret) => secret.id), [id]);
    // 元素必须是**含值**的完整记录：官方按 `key`/`value`/`note` 三者都在来解析
    assert.equal(all.secrets?.data[0].value, ENC_VALUE);
    assert.equal(all.secrets?.data[0].note, ENC_NOTE);

    // 省略 lastSyncedDate = 客户端从未同步 ⇒ 回全量（官方模型是 Option）
    const full = await readJson<SyncBody>((await call(h, path, 'GET', token)) as Response);
    assert.equal(full.hasChanges, true);
    assert.deepEqual(full.secrets?.data.map((secret) => secret.id), [id]);

    const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const none = await readJson<SyncBody>((await call(h, `${path}?lastSyncedDate=${future}`, 'GET', token)) as Response);
    assert.equal(none.hasChanges, false);
    assert.equal(none.secrets, undefined, '无变化时不带 secrets');
  } finally {
    h.handle.close();
  }
});

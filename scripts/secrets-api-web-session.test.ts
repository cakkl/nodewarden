// Web 会话走官方形态端点（`src/handlers/secrets-api.ts` 的用户那一侧）。
//
// 重点：① 非 SM 令牌必须**返回 null 放行** —— Web 自有的 `/api/secrets/organization*` 等路径
// 也会被「单段即 secret id」的规则认领，不放行就全死 ② owner 对整个组织可写，过滤逻辑与
// 机器账号共用 ③ orgId 不是自己的组织 ⇒ 404 ④ 还没有隐式组织 ⇒ 404
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleSecretsApiRoute, handleSecretsApiRouteForUser, isSecretsApiPath } from '../src/handlers/secrets-api';
import { createProject as insertProject } from '../src/services/storage-secrets-project-repo';
import { ensureImplicitOrganization } from '../src/services/storage-secrets-repo';
import type { Env } from '../src/types';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'user-1';
const NOW = '2026-01-01T00:00:00.000Z';
const ENC_KEY = '2.kkkkkkkkkkkkkkkkkkkkkk==|llllllllllllllllllllll==|mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm=';
const ENC_VALUE = '2.vvvvvvvvvvvvvvvvvvvvvv==|wwwwwwwwwwwwwwwwwwwwww==|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=';
const ENC_NAME = '2.nnnnnnnnnnnnnnnnnnnnnn==|oooooooooooooooooooooo==|ppppppppppppppppppppppppppppppppppppppppppp=';
/** 「没有备注」也要发空串的密文（官方客户端就是这么做的）。 */
const ENC_NOTE = '2.yyyyyyyyyyyyyyyyyyyyyy==|zzzzzzzzzzzzzzzzzzzzzz==|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
  orgId: string;
}

/** 默认建好隐式组织；传 `false` 用来看「用户还没有组织」的情况。 */
async function createHarness(withOrganization = true): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID);
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const orgId = withOrganization ? (await ensureImplicitOrganization(env.DB, USER_ID)).id : '';
  return { handle, connection: handle.connection, env, orgId };
}

function call(h: Harness, path: string, method: string, body?: unknown): Promise<Response | null> {
  return handleSecretsApiRouteForUser(
    new Request(`https://x${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    h.env,
    USER_ID,
    path,
    method
  );
}

async function callCreateProject(h: Harness): Promise<string> {
  const response = await call(h, `/api/organizations/${h.orgId}/projects`, 'POST', { name: ENC_NAME });
  assert.equal(response?.status, 200);
  return ((await response!.json()) as { id: string }).id;
}

async function callCreateSecret(h: Harness, projectId: string): Promise<string> {
  const response = await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', {
    key: ENC_KEY,
    value: ENC_VALUE,
    note: ENC_NOTE,
    projectIds: [projectId],
  });
  assert.equal(response?.status, 200);
  return ((await response!.json()) as { id: string }).id;
}

test('非 SM 令牌返回 null 放行，不吞掉 Web 会话自己的 /api/secrets/* 路径', async () => {
  const h = await createHarness();
  const cases: Array<[string, string]> = [
    ['/api/secrets/organization', 'GET'],
    ['/api/secrets/organization-key', 'GET'],
    ['/api/secrets/machine-accounts', 'GET'],
    [`/api/organizations/${h.orgId}/projects`, 'GET'],
  ];
  for (const [path, method] of cases) {
    // 根因：前三条**确实**会被本模块认领（`SECRET_PATH` 是「单段就是 secret id」的规则）
    // ⇒ 只有放行才能让它们活着，一旦改成 401 这三个端点就全死了
    assert.equal(isSecretsApiPath(path), true, `${path} 预期被本模块认领`);
    const response = await handleSecretsApiRoute(
      new Request(`https://x${path}`, { method, headers: { Authorization: 'Bearer user-session-token' } }),
      h.env,
      path,
      method
    );
    assert.equal(response, null, `${path} 应放行给用户令牌闸门`);
  }
});

test('owner 可建 project、列出与改名（无需任何授权表记录）', async () => {
  const h = await createHarness();
  const projectId = await callCreateProject(h);

  const listed = await call(h, `/api/organizations/${h.orgId}/projects`, 'GET');
  const listBody = (await listed!.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    listBody.data.map((project) => project.id),
    [projectId]
  );

  const renamed = await call(h, `/api/projects/${projectId}`, 'PUT', { name: ENC_KEY });
  assert.equal(renamed?.status, 200);
  assert.equal(((await renamed!.json()) as { name: string }).name, ENC_KEY);

  // 硬删（照官方）；空改名不是合法密文
  assert.equal((await call(h, `/api/projects/${projectId}`, 'PUT', { name: '' }))?.status, 400);
  const deleted = await call(h, '/api/projects/delete', 'POST', [projectId]);
  assert.deepEqual(await deleted!.json(), { object: 'list', data: [{ id: projectId, error: null }] });
});

test('owner 的 secret：列表不含值、取值走 get-by-ids、软删后不可见', async () => {
  const h = await createHarness();
  const projectId = await callCreateProject(h);
  const secretId = await callCreateSecret(h, projectId);

  const listed = await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET');
  const listBody = (await listed!.json()) as {
    object: string;
    secrets: Array<{ id: string; projects: Array<{ id: string }> } & Record<string, unknown>>;
    projects: Array<{ id: string }>;
  };
  assert.equal(listBody.object, 'list');
  assert.equal(listBody.secrets.length, 1);
  assert.equal('value' in listBody.secrets[0], false);
  assert.equal('note' in listBody.secrets[0], false);
  assert.deepEqual(
    listBody.secrets[0].projects.map((project) => project.id),
    [projectId]
  );
  assert.deepEqual(
    listBody.projects.map((project) => project.id),
    [projectId]
  );

  const byIds = await call(h, '/api/secrets/get-by-ids', 'POST', { ids: [secretId] });
  const byIdsBody = (await byIds!.json()) as { data: Array<{ value: string }> };
  assert.equal(byIdsBody.data[0].value, ENC_VALUE);

  const byProject = await call(h, `/api/projects/${projectId}/secrets`, 'GET');
  assert.equal(((await byProject!.json()) as { secrets: unknown[] }).secrets.length, 1);

  // 软删（进 Trash）之后单取就查不到了
  const deleted = await call(h, '/api/secrets/delete', 'POST', [secretId]);
  assert.deepEqual(await deleted!.json(), { object: 'list', data: [{ id: secretId, error: null }] });
  assert.equal((await call(h, `/api/secrets/${secretId}`, 'GET'))?.status, 404);
  assert.equal(((await (await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET'))!.json()) as { secrets: unknown[] }).secrets.length, 0);
});

test('机器账号建的 project 对 owner 同样可见（可见性不额外查授权表）', async () => {
  const h = await createHarness();
  await insertProject(h.env.DB, {
    id: 'project-from-machine',
    orgId: h.orgId,
    nameEncrypted: ENC_NAME,
    createdAt: NOW,
    revisionDate: NOW,
  });

  const listed = await call(h, `/api/organizations/${h.orgId}/projects`, 'GET');
  const listBody = (await listed!.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    listBody.data.map((project) => project.id),
    ['project-from-machine']
  );
});

test('路径里的 orgId 不是自己的组织 ⇒ 404', async () => {
  const h = await createHarness();
  assert.equal((await call(h, '/api/organizations/other-org/projects', 'GET'))?.status, 404);
  assert.equal((await call(h, '/api/organizations/other-org/secrets', 'GET'))?.status, 404);
});

test('用户还没有隐式组织 ⇒ 404', async () => {
  const h = await createHarness(false);
  assert.equal((await call(h, '/api/organizations/whatever/projects', 'GET'))?.status, 404);
});

test('未分配：owner 可不选 project 建机密，列表里看得到，也能把已分配的清空', async () => {
  const h = await createHarness();
  const projectId = await callCreateProject(h);

  // 一个 project 都不选（官方 `project_ids` 同样可选）—— 用来暂存那些「不能撤销或变更、
  // 又暂时用不到」的机密：不给它挂 project，机器账号就看不到它
  const created = await call(h, `/api/organizations/${h.orgId}/secrets`, 'POST', {
    key: ENC_KEY,
    value: ENC_VALUE,
    note: ENC_NOTE,
    projectIds: [],
  });
  assert.equal(created?.status, 200, 'owner 应当能建未分配机密');
  const unassigned = (await created!.json()) as { id: string; projects: unknown[] };
  assert.deepEqual(unassigned.projects, [], '不带任何 project');

  const listed = await call(h, `/api/organizations/${h.orgId}/secrets`, 'GET');
  const listBody = (await listed!.json()) as { secrets: Array<{ id: string; projects: unknown[] }> };
  const found = listBody.secrets.find((secret) => secret.id === unassigned.id);
  assert.ok(found, 'owner 的列表里应当有它（列表对 owner 返回全部）');
  assert.deepEqual(found?.projects, []);

  // 显式 `[]` 能把已分配的机密清空 ⇒ 变回「未分配」
  const assignedId = await callCreateSecret(h, projectId);
  const cleared = await call(h, `/api/secrets/${assignedId}`, 'PUT', {
    key: ENC_KEY,
    value: ENC_VALUE,
    note: ENC_NOTE,
    projectIds: [],
  });
  assert.deepEqual(((await cleared!.json()) as { projects: unknown[] }).projects, [], '应当清空关联');
});

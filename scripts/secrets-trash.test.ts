// 机密管理器的 Trash：满期清理（`src/services/secrets-trash.ts`）+ 回收站端点（`src/handlers/secrets.ts`）。
//
// 重点：① 只清满 30 天的（严格小于，边界另有用例）；未删的不动，关联行随本体级联删
// ② 列表只回已软删的 ③ 还原是「撒销软删」，对不在 Trash 里的 id 幂等且不报错
// ④ 组织只反查、不创建 —— 不能因为一次 GET 凭空建组织
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleSecretsTrashRoute } from '../src/handlers/secrets';
import { purgeSecretsTrash, SECRETS_TRASH_RETENTION_DAYS } from '../src/services/secrets-trash';
import {
  createSecret,
  ensureImplicitOrganization,
  setSecretProjects,
  softDeleteSecrets,
  type SmSecret,
} from '../src/services/storage-secrets-repo';
import { createProject } from '../src/services/storage-secrets-project-repo';
import type { Env } from '../src/types';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'user-1';
/** 固定的“现在”，避免测试结果随真实时钟漂移。 */
const NOW = Date.parse('2026-02-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const ENC_KEY = '2.kkkkkkkkkkkkkkkkkkkkkk==|llllllllllllllllllllll==|mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm=';
const ENC_VALUE = '2.vvvvvvvvvvvvvvvvvvvvvv==|wwwwwwwwwwwwwwwwwwwwww==|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=';
const ENC_NAME = '2.nnnnnnnnnnnnnnnnnnnnnn==|oooooooooooooooooooooo==|ppppppppppppppppppppppppppppppppppppppppppp=';

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

/** 造一个带指定 `deleted_at` 的 secret（`null` = 未删除），可顺手挂到某个 project 上。 */
async function seedSecret(h: Harness, id: string, deletedAt: string | null, projectId: string): Promise<void> {
  const secret: SmSecret = {
    id,
    orgId: h.orgId,
    keyEncrypted: ENC_KEY,
    valueEncrypted: ENC_VALUE,
    noteEncrypted: '',
    tagEncrypted: null,
    createdAt: CREATED_AT,
    revisionDate: CREATED_AT,
    deletedAt,
  };
  await createSecret(h.env.DB, secret);
  await setSecretProjects(h.env.DB, id, [projectId]);
}

async function seedProject(h: Harness, id: string): Promise<void> {
  await createProject(h.env.DB, {
    id,
    orgId: h.orgId,
    nameEncrypted: ENC_NAME,
    createdAt: CREATED_AT,
    revisionDate: CREATED_AT,
  });
}

function selectIds(h: Harness, table: string): string[] {
  const rows = h.connection.prepare(`SELECT id AS id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

test('满 30 天的 Trash 被物理清除，未满期与未删除的不动（关联行级联删除）', async () => {
  const h = await createHarness();
  try {
    await seedProject(h, 'project-1');
    await seedSecret(h, 'expired', new Date(NOW - (SECRETS_TRASH_RETENTION_DAYS + 1) * DAY_MS).toISOString(), 'project-1');
    await seedSecret(h, 'fresh-trash', new Date(NOW - (SECRETS_TRASH_RETENTION_DAYS - 1) * DAY_MS).toISOString(), 'project-1');
    await seedSecret(h, 'alive', null, 'project-1');

    assert.equal(await purgeSecretsTrash(h.env, NOW), 1);

    assert.deepEqual(selectIds(h, 'sm_secrets'), ['alive', 'fresh-trash']);
    // 关联行必须跟着本体走，否则「按 project 列」会查出幽灵 secret
    const links = h.connection
      .prepare('SELECT secret_id FROM sm_secret_projects ORDER BY secret_id')
      .all() as Array<{ secret_id: string }>;
    assert.deepEqual(
      links.map((row) => row.secret_id),
      ['alive', 'fresh-trash']
    );
  } finally {
    h.handle.close();
  }
});

test('边界：正好满 30 天的不清，再多一秒才清', async () => {
  const h = await createHarness();
  try {
    await seedProject(h, 'project-1');
    await seedSecret(h, 'exactly-30d', new Date(NOW - SECRETS_TRASH_RETENTION_DAYS * DAY_MS).toISOString(), 'project-1');

    assert.equal(await purgeSecretsTrash(h.env, NOW), 0);
    assert.equal(await purgeSecretsTrash(h.env, NOW + 1), 1);
    assert.deepEqual(selectIds(h, 'sm_secrets'), []);
  } finally {
    h.handle.close();
  }
});

test('空表返回 0；重复跑不会二次清除', async () => {
  const h = await createHarness();
  try {
    assert.equal(await purgeSecretsTrash(h.env, NOW), 0);

    await seedProject(h, 'project-1');
    await seedSecret(h, 'expired', new Date(NOW - 40 * DAY_MS).toISOString(), 'project-1');

    assert.equal(await purgeSecretsTrash(h.env, NOW), 1);
    assert.equal(await purgeSecretsTrash(h.env, NOW), 0);
  } finally {
    h.handle.close();
  }
});

function callTrash(h: Harness, path: string, method: string, body?: unknown): Promise<Response | null> {
  return handleSecretsTrashRoute(
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

test('回收站列表：只回已软删的，带 deletedAt 与 projectIds', async () => {
  const h = await createHarness();
  try {
    await seedProject(h, 'project-1');
    await seedSecret(h, 'trashed', null, 'project-1');
    await seedSecret(h, 'alive', null, 'project-1');
    const deletedAt = new Date(NOW - DAY_MS).toISOString();
    await softDeleteSecrets(h.env.DB, h.orgId, ['trashed'], deletedAt);

    const response = await callTrash(h, '/api/secrets/trash', 'GET');
    assert.equal(response?.status, 200);
    const body = (await response!.json()) as {
      object: string;
      secrets: Array<{ id: string; key: string; deletedAt: string; projectIds: string[] }>;
    };
    assert.equal(body.object, 'trash');
    assert.deepEqual(
      body.secrets.map((secret) => secret.id),
      ['trashed']
    );
    assert.equal(body.secrets[0].key, ENC_KEY);
    assert.equal(body.secrets[0].deletedAt, deletedAt);
    assert.deepEqual(body.secrets[0].projectIds, ['project-1']);
  } finally {
    h.handle.close();
  }
});

test('还原：回到正常列表、离开回收站；重复还原幂等且不报错', async () => {
  const h = await createHarness();
  try {
    await seedProject(h, 'project-1');
    await seedSecret(h, 'trashed', null, 'project-1');
    await softDeleteSecrets(h.env.DB, h.orgId, ['trashed'], new Date(NOW - DAY_MS).toISOString());

    const restored = await callTrash(h, '/api/secrets/trash/restore', 'POST', { ids: ['trashed'] });
    assert.equal(restored?.status, 200);
    assert.deepEqual(await restored!.json(), { object: 'trashRestore', restored: ['trashed'] });

    const listed = (await (await callTrash(h, '/api/secrets/trash', 'GET'))!.json()) as { secrets: unknown[] };
    assert.equal(listed.secrets.length, 0);
    const row = h.connection.prepare("SELECT deleted_at FROM sm_secrets WHERE id = 'trashed'").get() as {
      deleted_at: string | null;
    };
    assert.equal(row.deleted_at, null);

    // 幂等：已还原 / 不存在的 id 既不报错也不进 restored（不给出存在性线索）
    const again = await callTrash(h, '/api/secrets/trash/restore', 'POST', { ids: ['trashed', 'missing'] });
    assert.deepEqual(await again!.json(), { object: 'trashRestore', restored: [] });
  } finally {
    h.handle.close();
  }
});

test('还原的 body 必须是 id 数组；方法不匹配 405', async () => {
  const h = await createHarness();
  try {
    assert.equal((await callTrash(h, '/api/secrets/trash/restore', 'POST', { ids: 'trashed' }))?.status, 400);
    assert.equal((await callTrash(h, '/api/secrets/trash/restore', 'POST', {}))?.status, 400);
    assert.equal((await callTrash(h, '/api/secrets/trash/restore', 'POST', { ids: [''] }))?.status, 400);
    assert.equal((await callTrash(h, '/api/secrets/trash', 'POST'))?.status, 405);
    assert.equal((await callTrash(h, '/api/secrets/trash/restore', 'GET'))?.status, 405);
  } finally {
    h.handle.close();
  }
});

test('还没有隐式组织时回收站为空，且不会凭空建组织', async () => {
  const h = await createHarness(false);
  try {
    const response = await callTrash(h, '/api/secrets/trash', 'GET');
    assert.deepEqual(await response!.json(), { object: 'trash', secrets: [] });

    const orgs = h.connection.prepare('SELECT COUNT(*) AS n FROM sm_organizations').get() as { n: number };
    assert.equal(Number(orgs.n), 0);
  } finally {
    h.handle.close();
  }
});

test('单取：列表不带值，值走 `/trash/{id}`；**没软删的取不到**', async () => {
  const h = await createHarness();
  try {
    await seedProject(h, 'project-1');
    await seedSecret(h, 'trashed', null, 'project-1');
    await seedSecret(h, 'alive', null, 'project-1');
    await softDeleteSecrets(h.env.DB, h.orgId, ['trashed'], new Date(NOW - DAY_MS).toISOString());

    // 列表只回标识：值 / 备注不出现在列表响应里
    const listed = (await (await callTrash(h, '/api/secrets/trash', 'GET'))!.json()) as {
      secrets: Array<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(listed.secrets[0]).sort(), ['deletedAt', 'id', 'key', 'projectIds']);

    const detail = await callTrash(h, '/api/secrets/trash/trashed', 'GET');
    assert.equal(detail?.status, 200);
    const body = (await detail!.json()) as { id: string; value: string; note: string };
    assert.equal(body.id, 'trashed');
    assert.equal(body.value, ENC_VALUE);

    // ⚠️ 没进回收站的机密不能从这条路取到 —— 否则它就成了绕过正常两步取值的捷径
    assert.equal((await callTrash(h, '/api/secrets/trash/alive', 'GET'))?.status, 404);
    assert.equal((await callTrash(h, '/api/secrets/trash/missing', 'GET'))?.status, 404);
  } finally {
    h.handle.close();
  }
});

// 机密标签（本站 Web 扩展，官方线格式没有这个字段）。
//
// 钉住四件事（都是「不报错但会静默劣化」的类型）：
// ① 标签可存可取可清空，且**过路由层**（`/api/secrets/tags` 会被官方「单段即 secret id」规则
//    匹配到 id = "tags" ⇒ 挂载顺序错了就会被官方那套吞掉，直调 handler 测不出来）；
// ② ⭐ 改标签**不推进 `revision_date`** —— 推进了官方 `sync` 会把它当机密变更推给所有客户端，
//    前端离线快照的签名也跟着变、触发一次全量密文重传；
// ③ 官方响应形状**不受影响**：列表 / 单取里不得出现标签字段（那是 Web 独占概念）；
// ④ 标签只认合法密文；回收站里条目的标签不进 GET（回收站不参与分组）。
//
// 运行方式：npm run test:secrets-tag
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleAuthenticatedRoute } from '../src/router-authenticated';
import {
  createSecret,
  ensureImplicitOrganization,
  listSecretTags,
  type SmSecret,
} from '../src/services/storage-secrets-repo';
import type { Env, User } from '../src/types';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'tag-user';
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const ENC_KEY = '2.kkkkkkkkkkkkkkkkkkkkkk==|llllllllllllllllllllll==|mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm=';
const ENC_VALUE = '2.vvvvvvvvvvvvvvvvvvvvvv==|wwwwwwwwwwwwwwwwwwwwww==|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=';
/** 标签夹具：iv 16 字节 / ct 16 字节 / mac 32 字节（`isEncString` 会钉住长度，不能随便编）。 */
const ENC_TAG = '2.tttttttttttttttttttttt==|uuuuuuuuuuuuuuuuuuuuuu==|wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww=';

interface Harness {
  connection: DatabaseSync;
  env: Env;
  user: User;
  orgId: string;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID);
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const orgId = (await ensureImplicitOrganization(env.DB, USER_ID)).id;
  const user = { id: USER_ID, email: 'tag@example.test', role: 'user', status: 'active' } as unknown as User;
  return { connection: handle.connection, env, user, orgId };
}

async function seedSecret(h: Harness, id: string, deletedAt: string | null = null): Promise<void> {
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
}

/** 过路由层发请求（覆盖挂载顺序）。 */
async function dispatch(
  h: Harness,
  path: string,
  method: string,
  body?: unknown
): Promise<Response> {
  const request = new Request(`https://vault.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handleAuthenticatedRoute(request, h.env, USER_ID, h.user, path, method);
  assert.ok(response, `${method} ${path} 应被处理（返回 null 说明路由没挂上）`);
  return response;
}

/** 直接读库里的 revision_date（绕过仓库层映射）。 */
function revisionDateOf(h: Harness, id: string): string {
  const row = h.connection.prepare('SELECT revision_date AS r FROM sm_secrets WHERE id = ?').get(id) as
    | { r: string }
    | undefined;
  assert.ok(row, `secret ${id} 应存在`);
  return row.r;
}

test('标签：PUT 存 → GET 取 → PUT null 清空（过路由层）', async () => {
  const h = await createHarness();
  await seedSecret(h, 's1');
  await seedSecret(h, 's2');

  const empty = (await (await dispatch(h, '/api/secrets/tags', 'GET')).json()) as { tags: Record<string, string> };
  assert.deepEqual(empty.tags, {}, '未打标签时回空映射（不是 null / undefined）');

  const put = await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: ENC_TAG });
  assert.equal(put.status, 200);

  const listed = (await (await dispatch(h, '/api/secrets/tags', 'GET')).json()) as {
    tags: Record<string, string>;
  };
  assert.deepEqual(listed.tags, { s1: ENC_TAG }, '只回有标签的条目');

  const cleared = await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: null });
  assert.equal(cleared.status, 200);
  const afterClear = (await (await dispatch(h, '/api/secrets/tags', 'GET')).json()) as {
    tags: Record<string, string>;
  };
  assert.deepEqual(afterClear.tags, {}, 'null = 清除标签');

  // 清空后库里应是 NULL（不是空串 —— 空串不是合法密文，客户端解密会报错）
  const row = h.connection.prepare('SELECT tag_encrypted AS t FROM sm_secrets WHERE id = ?').get('s1') as {
    t: string | null;
  };
  assert.equal(row.t, null);
});

test('⭐ 改标签不推进 revision_date（否则官方 sync 会误报变更、离线快照整份重拉）', async () => {
  const h = await createHarness();
  await seedSecret(h, 's1');
  const before = revisionDateOf(h, 's1');

  await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: ENC_TAG });
  assert.equal(revisionDateOf(h, 's1'), before, '打标签不得推进 revision_date');

  await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: null });
  assert.equal(revisionDateOf(h, 's1'), before, '清除标签同样不得推进');
});

test('标签校验：非密文 / 非法 secretId / 不存在或已删除的条目', async () => {
  const h = await createHarness();
  await seedSecret(h, 's1');
  await seedSecret(h, 'gone', '2026-01-02T00:00:00.000Z');

  const plain = await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: 'prod' });
  assert.equal(plain.status, 400, '明文标签必须被拒（只能是密文）');

  const noId = await dispatch(h, '/api/secrets/tags', 'PUT', { tag: ENC_TAG });
  assert.equal(noId.status, 400);

  // 类型不对时宁可拒绝：静默「当成清除标签」会让手滑的调用方悄悄清掉标签
  const wrongType = await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: 42 });
  assert.equal(wrongType.status, 400);

  const missing = await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 'nope', tag: ENC_TAG });
  assert.equal(missing.status, 404);

  const trashed = await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 'gone', tag: ENC_TAG });
  assert.equal(trashed.status, 404, '回收站里的条目不接受标签写入（把它还原后再打）');

  const methodNotAllowed = await dispatch(h, '/api/secrets/tags', 'DELETE');
  assert.equal(methodNotAllowed.status, 405);
});

test('官方响应形状不受影响：列表 / 单取里不得出现标签字段', async () => {
  const h = await createHarness();
  await seedSecret(h, 's1');
  await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's1', tag: ENC_TAG });

  const listed = (await (await dispatch(h, `/api/organizations/${h.orgId}/secrets`, 'GET')).json()) as {
    secrets: Array<Record<string, unknown>>;
  };
  const item = listed.secrets[0];
  assert.ok(item, '列表应回一条机密');
  assert.equal('tag' in item, false, '官方列表信封不得带标签字段');
  assert.equal('tagEncrypted' in item, false);

  const single = (await (await dispatch(h, `/api/secrets/${item.id}`, 'GET')).json()) as Record<string, unknown>;
  assert.equal('tag' in single, false, '单取同样不得带标签字段');
});

test('GET 只回未删除条目的标签；还原后标签自动回来', async () => {
  const h = await createHarness();
  await seedSecret(h, 's1');
  await seedSecret(h, 's2');
  await dispatch(h, '/api/secrets/tags', 'PUT', { secretId: 's2', tag: ENC_TAG });

  // 软删 s2（进回收站）
  h.connection.prepare("UPDATE sm_secrets SET deleted_at = '2026-01-03T00:00:00.000Z' WHERE id = 's2'").run();
  const afterTrash = (await (await dispatch(h, '/api/secrets/tags', 'GET')).json()) as {
    tags: Record<string, string>;
  };
  assert.deepEqual(afterTrash.tags, {}, '回收站里的条目不参与分组 ⇒ 不出现在 GET 里');

  // 还原：标签还在库里
  h.connection.prepare('UPDATE sm_secrets SET deleted_at = NULL WHERE id = ?').run('s2');
  const afterRestore = (await (await dispatch(h, '/api/secrets/tags', 'GET')).json()) as {
    tags: Record<string, string>;
  };
  assert.deepEqual(afterRestore.tags, { s2: ENC_TAG }, '还原后标签自动回来');

  // 仓库层直读也应看得到
  const rows = await listSecretTags(h.env.DB, h.orgId);
  assert.deepEqual(rows, [{ id: 's1', tagEncrypted: null }, { id: 's2', tagEncrypted: ENC_TAG }]);
});

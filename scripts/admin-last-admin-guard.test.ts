// 「系统必须始终有一个能用的管理员」这条不变量的行为测试。
//
// 背景：`isAdmin()` 要求 `role === 'admin'` **且** `status === 'active'`，但兜底
// `ensureAdminUserExists()` 原先只查 `role = 'admin'` —— 口径不一致 ⇒「唯一管理员被 ban」会被
// 当成"已经有管理员"、从此再也不兜底（只能手工改库）；同一个不一致还让兜底把 banned 用户提权。
//
// 覆盖三块：① 计数口径只数「role=admin 且 status=active」；② 兜底不再被 banned 管理员卡住、且提权
// 对象必须可登录；③ 最后一个管理员的守卫与陈旧操作者快照必须被 403 拦下。
//
// 运行方式：npm run test:admin-last-admin
import assert from 'node:assert/strict';
import test from 'node:test';

import { guardLastActiveAdmin, handleAdminDeleteUser, handleAdminSetUserStatus } from '../src/handlers/admin';
import { AuthService } from '../src/services/auth';
import { StorageService } from '../src/services/storage';
import { ensureStorageSchema } from '../src/services/storage-schema';
import type { Env, User } from '../src/types';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

/** 客户端哈希（服务端再叠一层）；密码校验用真实实现生成，不手写 */
const CLIENT_HASH = 'client-side-hash-of-master-password';
const ADMIN_A = 'admin-a';
const ADMIN_B = 'admin-b';
const PLAIN_USER = 'plain-user';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  env: Env;
  storage: StorageService;
  /** 用户 id → 库里真实的 User 对象 */
  user: (id: string) => Promise<User>;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const storage = new StorageService(handle.db);
  return {
    handle,
    env,
    storage,
    user: async (id) => {
      const found = await storage.getUserById(id);
      assert.ok(found, `夹具应当在库里找到 ${id}`);
      return found;
    },
  };
}

/** 插一个密码就是 CLIENT_HASH 的用户（哈希走真实实现） */
async function seedUser(
  h: Harness,
  id: string,
  options: { role?: string; status?: string; createdAt?: string } = {}
): Promise<void> {
  const email = `${id}@example.test`;
  insertUser(h.handle.connection, id, {
    email,
    role: options.role,
    status: options.status,
    createdAt: options.createdAt,
    masterPasswordHash: await new AuthService(h.env).hashPasswordServer(CLIENT_HASH, email),
  });
}

function row(h: Harness, id: string): { role: string; status: string } {
  return h.handle.connection
    .prepare('SELECT role, status FROM users WHERE id = ?')
    .get(id) as { role: string; status: string };
}

function bootstrapAuditRows(h: Harness): Array<{ target_id: string }> {
  return h.handle.connection
    .prepare("SELECT target_id FROM audit_logs WHERE action = 'user.bootstrap.admin_promoted'")
    .all() as Array<{ target_id: string }>;
}

function deleteRequest(): Request {
  return new Request(`https://example.test/api/admin/users/${PLAIN_USER}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ masterPasswordHash: CLIENT_HASH }),
  });
}

function statusRequest(status: 'active' | 'banned'): Request {
  return new Request(`https://example.test/api/admin/users/${PLAIN_USER}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ status, masterPasswordHash: CLIENT_HASH }),
  });
}

// ---------------------------------------------------------------- 计数口径
test('口径：countActiveAdmins 只数「role=admin 且 status=active」，banned 管理员不算', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin' });
  await seedUser(h, ADMIN_B, { role: 'admin', status: 'banned' });
  await seedUser(h, PLAIN_USER);

  assert.equal(await h.storage.countActiveAdmins(), 1, '被 ban 的管理员不能占着“有管理员”的名额');
});

// ---------------------------------------------------------------- 兜底口径
test('兜底：唯一的管理员被 ban 时，把最早的**可登录**用户提权（并写审计事件）', async () => {
  const h = await createHarness();
  // A 最早、但被 ban；C 稍晚、可登录 ⇒ 应该提权 C，而不是"看到 admin 就收工"
  await seedUser(h, ADMIN_A, { role: 'admin', status: 'banned', createdAt: '2026-01-01T00:00:00.000Z' });
  await seedUser(h, PLAIN_USER, { createdAt: '2026-01-02T00:00:00.000Z' });

  await ensureStorageSchema(h.handle.db);

  assert.equal(row(h, ADMIN_A).status, 'banned', '不能因为兜底就悄悄解封一个被 ban 的管理员');
  // 注意：node:sqlite 的 .get() 返回 null-prototype 对象，deepEqual 会比原型，
  // 所以逐字段断言（而不是 deepEqual 整个行对象）。
  assert.equal(row(h, PLAIN_USER).role, 'admin');
  assert.equal(row(h, PLAIN_USER).status, 'active');
  assert.deepEqual(
    bootstrapAuditRows(h).map((entry) => entry.target_id),
    [PLAIN_USER],
    '提权必须留痕'
  );
});

test('兜底：所有用户都被 ban 时保持原样（提权 banned 用户毫无意义）', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin', status: 'banned', createdAt: '2026-01-01T00:00:00.000Z' });
  await seedUser(h, PLAIN_USER, { status: 'banned', createdAt: '2026-01-02T00:00:00.000Z' });

  await ensureStorageSchema(h.handle.db);

  assert.equal(row(h, ADMIN_A).role, 'admin');
  assert.equal(row(h, ADMIN_A).status, 'banned');
  assert.equal(row(h, PLAIN_USER).role, 'user', '不能把 banned 用户提权成管理员（isAdmin 仍为 false）');
  assert.deepEqual(bootstrapAuditRows(h), []);
});

test('兜底：已有可用管理员时不动任何行、也不写审计事件', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' });
  await seedUser(h, PLAIN_USER, { createdAt: '2026-01-02T00:00:00.000Z' });

  await ensureStorageSchema(h.handle.db);

  assert.equal(row(h, PLAIN_USER).role, 'user');
  assert.deepEqual(bootstrapAuditRows(h), []);
});

// ---------------------------------------------------------------- 守卫本体
test('守卫：目标是最后一个可用管理员 ⇒ 400；还有第二个 ⇒ 放行；目标不是可用管理员 ⇒ 放行', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin' });
  await seedUser(h, PLAIN_USER);

  const onlyAdmin = await h.user(ADMIN_A);
  const blocked = await guardLastActiveAdmin(h.storage, onlyAdmin);
  assert.equal(blocked?.status, 400, '仅剩一个可用管理员时必须拒绝');
  assert.match(await blocked!.text(), /last active administrator/i, '文案要能指导用户下一步');

  // 有第二个可用管理员 ⇒ 放行（正常工作流不能被误伤）
  await seedUser(h, ADMIN_B, { role: 'admin' });
  assert.equal(await guardLastActiveAdmin(h.storage, onlyAdmin), null);

  // 目标不是「可用管理员」⇒ 与不变量无关，放行
  const plain = await h.user(PLAIN_USER);
  assert.equal(await guardLastActiveAdmin(h.storage, plain), null);
  h.handle.connection.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(ADMIN_A);
  const bannedAdmin = await h.user(ADMIN_A);
  assert.equal(await guardLastActiveAdmin(h.storage, bannedAdmin), null, '封禁一个已失效的管理员不会让可用管理员归零');
});

// ---------------------------------------------------------------- handler 集成
test('删用户：普通用户照常删除（守卫不误伤 204 路径）', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin' });
  await seedUser(h, PLAIN_USER);

  const response = await handleAdminDeleteUser(deleteRequest(), h.env, await h.user(ADMIN_A), PLAIN_USER);

  assert.equal(response.status, 204);
  assert.equal(
    h.handle.connection.prepare('SELECT 1 AS hit FROM users WHERE id = ?').get(PLAIN_USER),
    undefined,
    '目标用户应当真的被删掉'
  );
});

test('删用户：操作者的陈旧快照（库里已不是可用管理员）⇒ 403，不采信缓存', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin' });
  await seedUser(h, ADMIN_B, { role: 'admin' });
  await seedUser(h, PLAIN_USER);

  const staleActor = await h.user(ADMIN_A);
  // 模拟"刚被别的管理员 ban 掉、但本 isolate 里还留着 15 s 旧快照"：库里改成 banned
  h.handle.connection.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(ADMIN_A);

  const response = await handleAdminDeleteUser(deleteRequest(), h.env, staleActor, ADMIN_B);

  assert.equal(response.status, 403, '被 ban 之后不能再用旧快照继续管理');
  assert.ok(
    h.handle.connection.prepare('SELECT 1 AS hit FROM users WHERE id = ?').get(ADMIN_B),
    '被拒绝的请求不能产生副作用'
  );
});

test('ban：普通用户可封禁；封禁自己被拦；陈旧操作者快照被 403 拦下', async () => {
  const h = await createHarness();
  await seedUser(h, ADMIN_A, { role: 'admin' });
  await seedUser(h, ADMIN_B, { role: 'admin' });
  await seedUser(h, PLAIN_USER);

  const adminA = await h.user(ADMIN_A);
  assert.equal((await handleAdminSetUserStatus(statusRequest('banned'), h.env, adminA, PLAIN_USER)).status, 200);
  assert.equal(row(h, PLAIN_USER).status, 'banned');

  assert.equal(
    (await handleAdminSetUserStatus(statusRequest('banned'), h.env, adminA, ADMIN_A)).status,
    400,
    '不能封禁自己'
  );

  // 陈旧快照：B 在库里已被 ban，测试仍传旧的 active 快照
  const staleActor = await h.user(ADMIN_B);
  h.handle.connection.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(ADMIN_B);
  const blocked = await handleAdminSetUserStatus(statusRequest('banned'), h.env, staleActor, PLAIN_USER);
  assert.equal(blocked.status, 403);
});

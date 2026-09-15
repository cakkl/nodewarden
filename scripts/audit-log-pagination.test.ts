// 日志中心分页的回归测试。
//
// 为什么需要它：`listAuditLogs` 曾经把 `total` 算成
// `offset + logs.length + (hasMore ? 1 : 0)` —— 那是"已走过的行数 + 本页行数"，
// 不是真实总数。后果是分页分母每翻一页恰好 +limit，`ceil(total/limit)` 恒等于"页码 + 1"：
// 用户看到 350/351 → 400/401、7/8 → 8/9，永远看不到真实条数与真实总页数
// （只有最后一页凑巧是对的）。这类"数字在自己动"的缺陷光看代码很难发现，
// 所以把"翻页时分母必须不变"写成断言。
//
// 运行方式：npm run test:audit-log-pagination
import assert from 'node:assert/strict';
import test from 'node:test';

import { listAuditLogs, createAuditLog } from '../src/services/storage-admin-repo';
import { createSchemaDatabase, insertUser, resetProcessScopedStatics } from './lib/test-harness';

const USER_A = 'user-audit-a';
const USER_B = 'user-audit-b';
const PAGE = 50;

/** 造一条审计日志：i 决定时间（越新 i 越大）与分类/级别，便于验证过滤分支 */
function seedLogs(handle: Awaited<ReturnType<typeof createSchemaDatabase>>, count: number): void {
  const insert = handle.connection.prepare(
    'INSERT INTO audit_logs (id, actor_user_id, action, category, level, target_type, target_id, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  for (let index = 0; index < count; index += 1) {
    const category = index % 3 === 0 ? 'auth' : 'data';
    const level = index % 5 === 0 ? 'security' : 'info';
    // created_at 递增：index 越大越新（列表按 DESC 排序）
    const created = `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:${String(index % 60).padStart(2, '0')}.${String(index % 1000).padStart(3, '0')}Z`;
    const actor = index % 2 === 0 ? USER_A : USER_B;
    insert.run(
      `audit-log-${String(index).padStart(4, '0')}`,
      actor,
      index % 4 === 0 ? 'vault.cipher.create' : 'auth.login.success',
      category,
      level,
      index % 7 === 0 ? 'user' : 'system',
      index % 7 === 0 ? USER_A : 'instance',
      '{}',
      created
    );
  }
}

async function freshHandle() {
  resetProcessScopedStatics();
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_A, { email: 'audit-a@example.test' });
  insertUser(handle.connection, USER_B, { email: 'audit-b@example.test' });
  return handle;
}

test('翻页时 total 必须保持不变，且等于真实总条数', async () => {
  const ROWS = 120;
  const handle = await freshHandle();
  seedLogs(handle, ROWS);

  const first = await listAuditLogs(handle.db, { limit: PAGE, offset: 0 });
  const second = await listAuditLogs(handle.db, { limit: PAGE, offset: PAGE });
  const third = await listAuditLogs(handle.db, { limit: PAGE, offset: PAGE * 2 });

  // 回归点：旧实现下这三个数会是 51 / 101 / 121
  for (const [label, page] of [['第 1 页', first], ['第 2 页', second], ['第 3 页', third]] as const) {
    assert.equal(page.total, ROWS, `${label}的 total 必须等于真实总条数 ${ROWS}`);
  }
  assert.equal(first.logs.length, PAGE);
  assert.equal(second.logs.length, PAGE);
  assert.equal(third.logs.length, ROWS - PAGE * 2, '最后一页只剩余数行');

  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.hasMore, false, '取满最后一页时不应再有下一页');

  // 总页数应当稳定（前端右上角就靠它）
  const totalPages = (result: { total: number }): number => Math.max(1, Math.ceil(result.total / PAGE));
  assert.equal(totalPages(first), 3);
  assert.equal(totalPages(second), 3);
  assert.equal(totalPages(third), 3);

  handle.close();
});

test('过滤条件下的 total 也必须等于该条件下的真实条数', async () => {
  const ROWS = 120;
  const handle = await freshHandle();
  seedLogs(handle, ROWS);
  const expected = (sql: string, ...params: (string | number | null)[]): number =>
    Number((handle.connection.prepare(sql).get(...params) as { count: number }).count);

  const authTotal = expected("SELECT COUNT(*) AS count FROM audit_logs WHERE category = 'auth'");
  const filtered = await listAuditLogs(handle.db, { limit: PAGE, offset: 0, category: 'auth' });
  assert.equal(filtered.total, authTotal, '按分类过滤时 total 必须是过滤后的条数');
  assert.ok(authTotal > 0 && authTotal < ROWS, '前置条件：过滤确实筛掉了行');

  const securityTotal = expected("SELECT COUNT(*) AS count FROM audit_logs WHERE level = 'security'");
  const byLevel = await listAuditLogs(handle.db, { limit: PAGE, offset: 0, level: 'security' });
  assert.equal(byLevel.total, securityTotal);

  const comboTtal = expected("SELECT COUNT(*) AS count FROM audit_logs WHERE category = 'data' AND level = 'info'");
  const combined = await listAuditLogs(handle.db, { limit: PAGE, offset: 0, category: 'data', level: 'info' });
  assert.equal(combined.total, comboTtal, '分类+级别组合过滤的 total 也要正确');

  // 关键词搜索会引用 actor.email / target.email，计数查询必须复用同一段 FROM
  const q = 'vault';
  const qTotal = expected(
    "SELECT COUNT(*) AS count FROM audit_logs l LEFT JOIN users actor ON actor.id = l.actor_user_id LEFT JOIN users target ON l.target_type = 'user' AND target.id = l.target_id WHERE LOWER(l.action) LIKE ?",
    '%vault%'
  );
  const searched = await listAuditLogs(handle.db, { limit: PAGE, offset: 0, q });
  assert.equal(searched.total, qTotal, '关键词搜索的 total 必须正确（且不能因 JOIN 缺失而报错）');
  assert.ok(qTotal > 0, '前置条件：搜索词应有命中');

  handle.close();
});

test('恰好取满一整页时 hasMore 必须为 false（不能凭 total 猜）', async () => {
  const ROWS = 100;
  const handle = await freshHandle();
  seedLogs(handle, ROWS);

  const first = await listAuditLogs(handle.db, { limit: PAGE, offset: 0 });
  const second = await listAuditLogs(handle.db, { limit: PAGE, offset: PAGE });

  assert.equal(first.total, ROWS);
  assert.equal(first.hasMore, true);
  assert.equal(second.total, ROWS);
  assert.equal(second.logs.length, PAGE);
  assert.equal(second.hasMore, false, '第 2 页正好取满 100 条时后面没有数据了');

  handle.close();
});

test('空库与越界 offset：total 为 0 / 不报错', async () => {
  const handle = await freshHandle();

  const empty = await listAuditLogs(handle.db, { limit: PAGE, offset: 0 });
  assert.deepEqual(empty.logs, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);

  seedLogs(handle, 10);
  const beyond = await listAuditLogs(handle.db, { limit: PAGE, offset: 500 });
  assert.deepEqual(beyond.logs, []);
  assert.equal(beyond.total, 10, '越界时 total 仍然是真实条数');

  handle.close();
});

// 「操作者」列的行内快照（audit_logs.actor_email）。
//
// 背景：actor_user_id 上有 `ON DELETE SET NULL` 外键，而 `DELETE FROM users` 会在
// 「从备份恢复」和「管理端删除用户」两条路径上跑 —— 那一刻该用户所有历史日志的
// actor_user_id 都被置成 NULL，且**不会自愈**（恢复虽把用户按同样 id 写回，
// 但没有任何代码把值算回来）。表现就是日志中心「操作者」永久显示 `—`、
// 按操作者邮箱搜索永久失效。
//
// 修法是写入时在行内抄一份邮箱。本测试断言的就是这条快照链路：
// ① `createAuditLog` 真的写了快照；② 编号被置空后仍能显示；③ 搜索也还命中。
test('恢复/删用户把 actor_user_id 置空后，操作者邮箱仍能显示与搜索', async () => {
  const handle = await freshHandle();
  const ACTOR_EMAIL = 'audit-a@example.test';

  // 必须走生产写入路径，快照才会被填上（直接 INSERT 是绕过快照的）。
  await createAuditLog(handle.db, {
    id: 'audit-snapshot-1',
    actorUserId: USER_A,
    action: 'vault.cipher.create',
    category: 'data',
    level: 'info',
    targetType: 'cipher',
    targetId: 'cipher-1',
    metadata: '{}',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  // 前置条件：正常状态下两者都在
  const before = await listAuditLogs(handle.db, { limit: PAGE, offset: 0 });
  assert.equal(before.logs.length, 1);
  assert.equal(before.logs[0].actorUserId, USER_A);
  assert.equal(before.logs[0].actorEmail, ACTOR_EMAIL, '写入时应已把邮箱快照进这一行');

  // 模拟恢复：DELETE FROM users（外键触发 SET NULL）→ 再把用户按同样的 id 写回。
  // 这正是 backup-import.ts 的 swapShadowTablesIntoPlace 做的事。
  handle.connection.exec('PRAGMA foreign_keys = ON');
  handle.connection.prepare('DELETE FROM users WHERE id = ?').run(USER_A);
  insertUser(handle.connection, USER_A, { email: ACTOR_EMAIL });

  const after = await listAuditLogs(handle.db, { limit: PAGE, offset: 0 });
  assert.equal(
    after.logs[0].actorUserId,
    null,
    '前置条件：外键应已把编号置空。若这里不是 null，说明本测试没有覆盖到真实场景（外键未生效）'
  );
  assert.equal(
    after.logs[0].actorEmail,
    ACTOR_EMAIL,
    '编号被置空后，行内快照必须仍然保留操作者邮箱 —— 否则日志中心的「操作者」会永久变成 —'
  );

  // 搜索同理：恢复后 actor.email 那个 JOIN 已经查不到东西，只能靠快照命中。
  const searched = await listAuditLogs(handle.db, { limit: PAGE, offset: 0, q: ACTOR_EMAIL });
  assert.equal(searched.total, 1, '恢复后仍应能按操作者邮箱搜到日志');
  assert.equal(searched.logs[0].id, 'audit-snapshot-1');

  handle.close();
});

// 应用版本启动记录的行为验证（写入 system.app.version.started → 出现在 Web 端「日志中心」）
//
// 为什么必须有：
//   1. 判定逻辑藏在"读 config → 比较 → 原子认领 → 写审计事件"这条链上，任何一环写错都会静默失效
//      （元数据忘了登记白名单 → 字段被丢掉；把判定写成"先读再写" → 并发时日志中心出现重复条目）。
//   2. 部署瞬间会有多个 isolate 同时冷启动，重复条目正是最可能出问题的地方，所以"并发只写一条"是
//      这里最重要的断言。
//
// 运行方式：npm run test:app-version-log
import assert from 'node:assert/strict';
import test from 'node:test';

import { APP_VERSION } from '../shared/app-version';
import {
  APP_VERSION_ACTION,
  APP_VERSION_CONFIG_KEY,
  resetAppVersionTrackingForTests,
  trackAppVersionOnce,
} from '../src/services/app-version-log';
import type { Env } from '../src/types';
import { createSchemaDatabase } from './lib/test-harness';

interface AuditRow {
  action: string;
  category: string;
  level: string;
  actor_user_id: string | null;
  target_type: string | null;
  metadata: string;
}

function buildEnv(db: Env['DB'], versionMeta?: Env['CF_VERSION_METADATA']): Env {
  return {
    DB: db,
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
    ...(versionMeta ? { CF_VERSION_METADATA: versionMeta } : {}),
  } as unknown as Env;
}

function readVersionRows(handle: { connection: { prepare: (sql: string) => any } }): AuditRow[] {
  return handle.connection
    .prepare('SELECT action, category, level, actor_user_id, target_type, metadata FROM audit_logs WHERE action = ? ORDER BY created_at')
    .all(APP_VERSION_ACTION) as AuditRow[];
}

function readStoredRecord(handle: { connection: { prepare: (sql: string) => any } }): string | null {
  const row = handle.connection.prepare('SELECT value FROM config WHERE key = ?').get(APP_VERSION_CONFIG_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** 把随机性钉住：让概率门控的低频清理永远不触发，断言不受噪声影响 */
async function withDeterministicRandom<T>(run: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => 1;
  try {
    return await run();
  } finally {
    Math.random = original;
  }
}

test('首次启动写入一条系统事件，并把当前版本落到 config', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    resetAppVersionTrackingForTests();

    await trackAppVersionOnce(buildEnv(handle.db, { id: 'deploy-1', timestamp: '2026-09-13T00:00:00.000Z' }));

    const rows = readVersionRows(handle);
    assert.equal(rows.length, 1, '首次启动应当写一条');
    assert.equal(rows[0].action, APP_VERSION_ACTION);
    assert.equal(rows[0].category, 'system');
    assert.equal(rows[0].level, 'info');
    assert.equal(rows[0].actor_user_id, null, '系统事件没有操作者');

    // 元数据必须完整 —— 这条专门防"忘了往 ALLOWED_METADATA_KEYS 登记"的回归：
    // 未登记的键会被 sanitizeMetadata 静默丢掉，这里就会缺字段。
    const metadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    assert.equal(metadata.version, APP_VERSION);
    assert.equal(metadata.deploymentId, 'deploy-1');
    assert.equal(metadata.deployedAt, '2026-09-13T00:00:00.000Z');
    assert.equal(metadata.previousVersion, undefined, '首次没有上一版本');

    assert.ok(readStoredRecord(handle)?.includes(APP_VERSION), 'config 里应当记下当前版本');
  });
});

test('版本没变时不再写第二条', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    const env = buildEnv(handle.db, { id: 'deploy-1' });

    resetAppVersionTrackingForTests();
    await trackAppVersionOnce(env);
    // 模拟"同一个版本又来了一个全新 isolate"
    resetAppVersionTrackingForTests();
    await trackAppVersionOnce(env);

    assert.equal(readVersionRows(handle).length, 1, '同版本重复启动不应再写');
  });
});

test('版本号变了 → 写出旧版本与上一版本的对照', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    // 预置一个"上一版本"的记录，模拟从旧版本升级上来
    handle.connection
      .prepare('INSERT INTO config(key, value) VALUES(?, ?)')
      .run(APP_VERSION_CONFIG_KEY, JSON.stringify({ version: '1.7.0', deploymentId: 'deploy-old' }));

    resetAppVersionTrackingForTests();
    await trackAppVersionOnce(buildEnv(handle.db, { id: 'deploy-new' }));

    const rows = readVersionRows(handle);
    assert.equal(rows.length, 1);
    const metadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    assert.equal(metadata.version, APP_VERSION);
    assert.equal(metadata.previousVersion, '1.7.0');
    assert.equal(metadata.deploymentId, 'deploy-new');
  });
});

test('版本号没变、仅重新构建部署（deployment id 变了）也要记录', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    resetAppVersionTrackingForTests();
    await trackAppVersionOnce(buildEnv(handle.db, { id: 'deploy-1' }));

    // 版本号一模一样，只有 Cloudflare 的 deployment id 换了
    resetAppVersionTrackingForTests();
    await trackAppVersionOnce(buildEnv(handle.db, { id: 'deploy-2' }));

    const rows = readVersionRows(handle);
    assert.equal(rows.length, 2, '仅重新部署也应当留下记录');
    const metadata = JSON.parse(rows[1].metadata) as Record<string, unknown>;
    assert.equal(metadata.deploymentId, 'deploy-2');
    assert.equal(metadata.previousVersion, APP_VERSION, '版本号没变，但仍应标出上一版本');
  });
});

test('并发冷启动只写一条（原子认领）', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    const env = buildEnv(handle.db, { id: 'deploy-1' });

    // 注意这里为什么要两次 reset：
    // 模块内的"本 isolate 已检查"标志会合并同一 isolate 的并发调用 ——
    // 那是第一道闸；要验证**SQL 层的原子认领**（多 isolate 同时冷启动），
    // 必须让两个调用各自独立地跑完"读 → 比较 → 认领"这条链。
    resetAppVersionTrackingForTests();
    const first = trackAppVersionOnce(env);
    resetAppVersionTrackingForTests();
    const second = trackAppVersionOnce(env);
    await Promise.all([first, second]);

    assert.equal(readVersionRows(handle).length, 1, '并发认领时只能有一条记录');
  });
});

test('同一 isolate 内重复调用被标志位短路（不会反复查库）', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    resetAppVersionTrackingForTests();

    const env = buildEnv(handle.db, { id: 'deploy-1' });
    await Promise.all([trackAppVersionOnce(env), trackAppVersionOnce(env), trackAppVersionOnce(env)]);

    assert.equal(readVersionRows(handle).length, 1);
    // 第二次起应当直接返回，不再产生新的日志
    await trackAppVersionOnce(env);
    assert.equal(readVersionRows(handle).length, 1);
  });
});

test('数据库不可用时只记录错误、不抛出（绝不能影响请求）', async () => {
  await withDeterministicRandom(async () => {
    const handle = await createSchemaDatabase();
    handle.connection.exec('DROP TABLE config');
    resetAppVersionTrackingForTests();

    await assert.doesNotReject(() => trackAppVersionOnce(buildEnv(handle.db, { id: 'deploy-1' })));
  });
});

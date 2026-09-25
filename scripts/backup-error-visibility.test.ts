// 「备份失败 / 被跳过」的可观察性护栏。
//
// 两条都是真机验收时发现的**静默**问题 —— 功能没坏，但人看不到发生了什么：
//   ① 每次尝试一开始就清空 `lastErrorMessage`、而失败不更新 `lastSuccessAt` ⇒ 计划任务在容差窗口内
//      立刻重试，形成「清空 → 30 s 后写回 → 立刻又清空」的循环，那条错误几乎永远看不到。
//      修法：清空只发生在**成功**分支。
//   ② 租约被他人持有时 DO 回 409、handler 直接 return ⇒「这一轮被跳过」毫无留痕。
//      修法：`console.warn` + 一条 `system` 审计事件。
//
// ① 用源码断言而非跑一遍备份：要在两次尝试之间读 `runtime` 才能观测，单测里得 stub 掉整条远端链路，
// 收益低于成本；源码断言直接锁住「那段 update 里不许出现 lastError*」。
//
// 运行方式：npm run test:backup-visibility
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runScheduledBackupIfDue } from '../src/handlers/backup';
import type { Env } from '../src/types';
import { createSchemaDatabase, TEST_JWT_SECRET } from './lib/test-harness';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BACKUP_HANDLER_PATH = path.join(REPO_ROOT, 'src/handlers/backup.ts');

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  envFor: (fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => Env;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  return {
    handle,
    envFor: (fetchImpl) => ({
      DB: handle.db,
      JWT_SECRET: TEST_JWT_SECRET,
      BACKUP_TRANSFER_RUNNER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchImpl }),
      },
    } as unknown as Env),
  };
}

function skippedAuditRows(h: Harness): Array<{ category: string; level: string; actor_user_id: string | null; metadata: string }> {
  return h.handle.connection
    .prepare(
      "SELECT category, level, actor_user_id, metadata FROM audit_logs WHERE action = 'backup.scheduled.skipped'"
    )
    .all() as Array<{ category: string; level: string; actor_user_id: string | null; metadata: string }>;
}

/** 捕获 console.warn，避免污染测试输出 */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

// ----------------------------------------------- 行为：计划任务被跳过须留痕
test('租约被占用（409）：写一条 system 审计事件 + 一条 console.warn，而不是静默返回', async () => {
  const h = await createHarness();
  const env = h.envFor(async () =>
    new Response(JSON.stringify({ error: 'Another backup run is already in progress' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const warnings = await captureWarnings(() => runScheduledBackupIfDue(env));

  const rows = skippedAuditRows(h);
  assert.equal(rows.length, 1, '「被跳过」必须留痕');
  assert.equal(rows[0].category, 'system');
  assert.equal(rows[0].level, 'warn');
  assert.equal(rows[0].actor_user_id, null, '计划任务没有操作者');
  assert.match(rows[0].metadata, /lease_held/);
  assert.match(rows[0].metadata, /already in progress/);
  assert.equal(warnings.length, 1, '同时要有一条 console.warn（Workers Logs / wrangler tail 能看到）');
  assert.match(warnings[0], /scheduled backup skipped/);
});

test('未占用（200）：不写审计、不 warn（避免每次 cron 都刷日志）', async () => {
  const h = await createHarness();
  const env = h.envFor(async () => new Response('{}', { status: 200 }));

  const warnings = await captureWarnings(() => runScheduledBackupIfDue(env));

  assert.deepEqual(skippedAuditRows(h), []);
  assert.deepEqual(warnings, []);
});

test('真正的失败（500）仍然照旧抛错 —— 留痕不改变失败语义', async () => {
  const h = await createHarness();
  const env = h.envFor(async () =>
    new Response(JSON.stringify({ error: 'Scheduled backup failed' }), { status: 500 })
  );

  await assert.rejects(() => runScheduledBackupIfDue(env), /Scheduled backup failed/);
  assert.deepEqual(skippedAuditRows(h), [], '500 不是「被跳过」，不该写 skipped 事件');
});

// ----------------------------------- 源码护栏：尝试开始不得清空 lastError*
test('源码护栏：备份尝试开始时不得清空 lastError*（否则错误会被重试循环吃掉）', () => {
  const source = readFileSync(BACKUP_HANDLER_PATH, 'utf8');

  const anchor = 'lastAttemptAt: now.toISOString()';
  const anchorIndex = source.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, '找不到「尝试开始」那段 runtime 更新：形状变了请同步更新本护栏');
  const attemptUpdate = source.slice(anchorIndex, anchorIndex + 400).split('}));')[0];
  assert.ok(
    !attemptUpdate.includes('lastErrorMessage'),
    '尝试开始时不得清空 lastErrorMessage：失败会让计划任务立刻重试，错误就在「清空 ↔ 写回」循环里消失'
  );
  assert.ok(!attemptUpdate.includes('lastErrorAt'), '同上：lastErrorAt 也要保留，否则无法判断错误是什么时候的');

  // 反方向：成功分支**必须**清空（否则修成「错误永远不消失」）
  const successAnchor = 'lastSuccessAt: new Date().toISOString()';
  const successIndex = source.indexOf(successAnchor);
  assert.notEqual(successIndex, -1, '找不到成功分支的 runtime 更新：形状变了请同步更新本护栏');
  const successUpdate = source.slice(successIndex, successIndex + 400).split('}));')[0];
  assert.ok(successUpdate.includes('lastErrorMessage: null'), '成功时必须清空上次的错误，否则界面会一直显示陈旧失败');
});

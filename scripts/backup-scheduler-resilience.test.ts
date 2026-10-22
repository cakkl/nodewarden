// 计划备份调度链路的韧性护栏（源码 + 纯函数，不依赖 DO 运行时）。
//
// 瞪的是「别退回旧写法」：线上那两类事故（DO 实例被重置后租约残留、D1 瞬时断连废掉整轮
// cron）只能靠时间+运气复现，本地跑不出来。
//
// 运行方式：npm run test:backup-scheduler-guards
//
// 运行方式：npm run test:backup-scheduler-guards
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 去掉注释 —— 否则注释里写过的代码片段会被当成「存在」。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 截取某个方法体（从方法签名到下一个同级 `private`/`async` 成员）。 */
function methodBody(source: string, signature: string, until: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `找不到 ${signature}（改名了请同步本护栏）`);
  const end = source.indexOf(until, start);
  assert.notEqual(end, -1, `找不到 ${until}（改名了请同步本护栏）`);
  return source.slice(start, end);
}

const runner = stripComments(readSource('src/durable/backup-transfer-runner.ts'));
const scheduledBody = methodBody(
  runner,
  'private async runScheduledBackups(',
  'private async restoreRemoteBackup('
);

test('空转 tick 不得写租约：到期预检必须早于 acquireJob', () => {
  const previewAt = scheduledBody.indexOf('loadBackupSettings(');
  const acquireAt = scheduledBody.indexOf("acquireJob('scheduled')");

  assert.notEqual(previewAt, -1, 'runScheduledBackups 里找不到到期预检（loadBackupSettings）');
  assert.notEqual(acquireAt, -1, 'runScheduledBackups 里找不到 acquireJob');
  assert.ok(
    previewAt < acquireAt,
    '⚠️ 必须先判到期再抢租约：倒过来会让每个空转 tick 都写一次租约，任一次被打断就留下残留租约，' +
      '后续 tick 会误报「已有任务占用租约」，还可能挡住真正该跑的那一次'
  );
  assert.match(
    scheduledBody,
    /return scheduledBackupCompleted\(0, \[\]\);/,
    '没有到期目的地时应直接返回空的成功响应（而不是抢租约后 409）'
  );
});

test('残留租约按心跳接管：心跳新鲜才让路', () => {
  const acquireBody = methodBody(runner, 'private async acquireJob(', 'private async touchJob(');
  assert.match(
    acquireBody,
    /nowMs - touchedMs < BACKUP_JOB_STALE_MS/,
    'acquireJob 必须比较「心跳是否新鲜」——否则实例重置留下的租约要干等满 10 分钟'
  );
  assert.match(
    runner,
    /const BACKUP_JOB_STALE_MS = 3 \* BACKUP_JOB_HEARTBEAT_MS;/,
    '接管阈值应为 3 个心跳周期（90s）；改大前先确认最长静默段（整包上传上限 10 分钟）'
  );
});

test('心跳必须用定时器，且三个写任务都在 finally 里停掉', () => {
  const heartbeatBody = methodBody(runner, 'private startJobHeartbeat(', 'private async releaseJob(');
  assert.match(heartbeatBody, /setInterval\(/, '心跳必须是定时器式');
  assert.match(heartbeatBody, /clearInterval\(timer\);/, '停止函数必须清掉定时器');
  assert.match(heartbeatBody, /await pending\.catch\(/, '停止时必须等在途心跳落盘，避免请求结束后还有悬挂事务');

  const starts = runner.match(/const stopHeartbeat = this\.startJobHeartbeat\(token\);/g) ?? [];
  const stops = runner.match(/^\s*await stopHeartbeat\(\);$/gm) ?? [];
  assert.equal(starts.length, 3, '手动备份 / 计划备份 / 远程恢复三处都要起心跳');
  assert.equal(stops.length, 3, '三处 finally 都要停心跳');

  // 停止必须在 releaseJob 之前：先停心跳再删租约，避免释后被心跳写回
  for (const match of runner.matchAll(/await stopHeartbeat\(\);\s*\n\s*await this\.releaseJob\(token\);/g)) {
    assert.ok(match, 'stopHeartbeat 必须紧挨在 releaseJob 之前');
  }
  assert.equal(
    (runner.match(/await stopHeartbeat\(\);\s*\n\s*await this\.releaseJob\(token\);/g) ?? []).length,
    3,
    '三处都必须是「先停心跳、再释放租约」'
  );
});

test('releaseJob 必须尽力而为：收尾失败不得把成功改写成失败', () => {
  const releaseBody = methodBody(runner, 'private async releaseJob(', 'private async runConfiguredBackup(');
  assert.match(releaseBody, /try \{/, 'releaseJob 需要 try/catch 包住事务');
  assert.match(
    releaseBody,
    /catch \(error\)[\s\S]*console\.warn/,
    '失败只能记日志 —— 抛出去会让已经跑完的备份变成失败响应'
  );
});

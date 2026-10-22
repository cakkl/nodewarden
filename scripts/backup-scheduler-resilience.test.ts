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

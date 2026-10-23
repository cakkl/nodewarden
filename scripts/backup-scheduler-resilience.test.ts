// 计划备份调度链路的韧性护栏（源码 + 纯函数，不依赖 DO 运行时）。
//
// 瞪的是「别退回旧写法」：线上那两类事故（DO 实例被重置后租约残留、D1 瞬时断连废掉整轮
// cron）只能靠时间+运气复现，本地跑不出来。
//
// 运行方式：npm run test:backup-scheduler-guards
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { backupSchedulerWindowMinutes } from '../src/services/backup-config';
import type { BackupDestinationRecord } from '../src/services/backup-config';

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

function destinationWithInterval(intervalHours: unknown): BackupDestinationRecord {
  return { schedule: { intervalHours } } as unknown as BackupDestinationRecord;
}

test('到期窗口按间隔推导：放宽到能容纳多次重试，又不与下一个 slot 重叠', () => {
  // 默认每天一次：窗口 60 分钟 ⇒ 12 次 cron 机会（原来只有 1 次）
  assert.equal(backupSchedulerWindowMinutes(destinationWithInterval(24)), 60);
  // 每 6 小时：仍取 60 分钟，远小于 360 分钟间隔
  assert.equal(backupSchedulerWindowMinutes(destinationWithInterval(6)), 60);
  // 每小时：取间隔的一半，避免与下一小时撞车
  assert.equal(backupSchedulerWindowMinutes(destinationWithInterval(1)), 30);
  // 异常/缺失值回落默认窗口，不能算出 0 或 NaN
  assert.equal(backupSchedulerWindowMinutes(destinationWithInterval(0)), 5);
  assert.equal(backupSchedulerWindowMinutes(destinationWithInterval('x')), 5);

  // 不变量：任何合法间隔下，窗口都严格小于间隔（否则会连续两次命中同一 slot）
  for (const hours of [1, 2, 3, 6, 12, 24, 99]) {
    const window = backupSchedulerWindowMinutes(destinationWithInterval(hours));
    assert.ok(window > 0 && window < hours * 60, `间隔 ${hours}h 的窗口 ${window} 分钟越界`);
  }
});

test('失败后要退避，且退避窗口明显小于到期窗口（能补跑又不刷日志）', () => {
  assert.match(
    runner,
    /const BACKUP_RETRY_BACKOFF_MS = 15 \* 60 \* 1000;/,
    '缺少重试退避常量：60 分钟窗口里会每 5 分钟刷一条失败记录'
  );
  const dueBody = methodBody(runner, 'private dueDestinations(', 'private async runScheduledBackups(');
  assert.match(dueBody, /!this\.isRetryBackoffActive\(destination, now\)/, '到期判定必须先排除退避中的目的地');
  assert.match(
    dueBody,
    /backupSchedulerWindowMinutes\(destination\)/,
    '到期判定必须用按间隔推导的窗口，而不是固定 5 分钟'
  );
});

const indexSource = stripComments(readSource('src/index.ts'));
const backupHandlers = stripComments(readSource('src/handlers/backup.ts'));

test('DB init 对瞬态错误重试，别让一次断连废掉整轮 cron', () => {
  assert.match(indexSource, /const DB_INIT_ATTEMPTS = 3;/, '缺少重试次数常量');
  assert.match(
    indexSource,
    /network connection lost\|connection closed\|no longer active/i,
    '瞬态错误判定必须覆盖 D1 断连与 DO 重置这两类（线上都实测过）'
  );
  assert.match(
    indexSource,
    /await initializeDatabaseWithRetry\(env\);/,
    'ensureDatabaseInitialized 必须走带重试的初始化'
  );
});

test('「整轮跳过 / 失败」必须写审计事件（只有 console 等于隐身）', () => {
  // DB init 失败 → 整轮 cron 跳过
  assert.match(
    indexSource,
    /action: 'system\.db\.init\.failed'[\s\S]*?targetType: 'system'/,
    'DB init 失败必须写审计事件，否则日志中心看不到「整轮被跳过」'
  );
  // 备份真的失败 → 留痕
  assert.match(
    backupHandlers,
    /action: 'backup\.scheduled\.failed'/,
    '计划备份失败必须写审计事件'
  );
  const failureWrites = backupHandlers.match(/await writeScheduledBackupFailure\(env, /g) ?? [];
  assert.equal(
    failureWrites.length,
    2,
    'DO 请求抛错（实例重置）与非 2xx 两种失败都要留痕'
  );
});

test('备份成功后的收尾读取失败，不得把整轮改写为失败', () => {
  const loopRead = scheduledBody.indexOf('settings = await loadBackupSettings(');
  assert.notEqual(loopRead, -1, '循环里找不到 loadBackupSettings 调用（结构变了？）');
  const before = scheduledBody.slice(Math.max(0, loopRead - 240), loopRead);
  assert.match(before, /try \{/, '循环里的配置读取必须包在 try 里');
  const after = scheduledBody.slice(loopRead, loopRead + 420);
  assert.match(
    after,
    /if \(completed > 0 \|\| failures\.length > 0\) \{[\s\S]*?warning = [\s\S]*?break;/,
    '已经跑过时应收尾为 warning + break，而不是抛出'
  );
  assert.match(after, /throw error;/, '一件都没做时（completed / failures 均为 0）仍要抛 —— 那才是真失败');
  assert.match(runner, /warning: warning \|\| null,/, '结果体必须带 warning 字段');
});

test('手动备份同理：收尾读配置失败不得否掉已成功的结果', () => {
  const configuredBody = methodBody(runner, 'private async runConfiguredBackup(', 'private isRetryBackoffActive(');
  assert.match(
    configuredBody,
    /let settings: BackupSettings \| null = null;/,
    '手动路径的 settings 必须允许为 null（它只用于回填响应体）'
  );
  const tryAt = configuredBody.indexOf('settings = await loadBackupSettings(');
  assert.notEqual(tryAt, -1, '找不到收尾的 loadBackupSettings');
  const before = configuredBody.slice(Math.max(0, tryAt - 200), tryAt);
  assert.match(before, /try \{/, '收尾读取必须包在 try 里');
  assert.match(
    configuredBody.slice(tryAt, tryAt + 220),
    /catch \(error\)[\s\S]*?console\.warn/,
    '失败只能记日志，不能让备份结果变成报错'
  );

  // handler 侧：settings 允许缺省
  assert.match(
    backupHandlers,
    /settings: BackupSettings \| null;/,
    'DurableBackupRunResponse.settings 必须允许 null'
  );
  assert.match(
    backupHandlers,
    /if \(!body\?\.result\) \{/,
    'handler 不得因为 settings 缺失就判响应无效'
  );
  assert.match(
    backupHandlers,
    /settings: outcome\.settings \? redactBackupSettingsSecrets\(outcome\.settings\) : null,/,
    'settings 为 null 时要原样回 null，让前端沿用本地配置'
  );

  // 前端也缺一不可：它原来同样断言 settings 必存在，会把成功的备份报成「响应无效」
  const webApi = stripComments(readSource('webapp/src/lib/api/backup.ts'));
  assert.match(
    webApi,
    /if \(!body\?\.result\) throw new Error\(t\('txt_backup_remote_run_invalid_response'\)\);/,
    '前端只应校验 result：settings 为 null 是合法响应'
  );
  assert.doesNotMatch(
    webApi,
    /if \(!body\?\.result \|\| !body\?\.settings\)/,
    '前端不得再要求 settings 存在'
  );
});

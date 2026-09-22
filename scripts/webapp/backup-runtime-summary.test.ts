// 备份目标「最近运行」摘要的测试。
//
// 后端在 `runtime` 里同时保留 `lastSuccessAt` 与 `lastErrorAt` / `lastErrorMessage`，且只在**成功**
// 时清空错误。详情页只展示**失败**（「上次成功」在左侧地点列表里已有），所以这里只测失败那一支。
//
// 测的是**纯函数** `getDestinationRuntimeSummary()`，盯住两件容易静默出错的事：
//   ① 没有失败时不能凭空造出一行「上次失败」（否则详情页会多一个空框）；
//   ② 失败原因必须走 `translateServerError()`，但**未命中时必须保留原文** —— 刻意不回落到通用文案，
//      具体原因才是排障线索。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultBackupRuntimeState } from '../../shared/backup-schema';
import { getDestinationRuntimeSummary } from '../../webapp/src/lib/backup-center';

/** 默认语言包是英文（`webapp/src/lib/i18n.ts` 在模块加载时初始化），故断言用英文文案 */
test('从未运行过：不产生「上次失败」', () => {
  const summary = getDestinationRuntimeSummary(createDefaultBackupRuntimeState());

  assert.equal(summary.failedAt, null);
  assert.equal(summary.failureReason, null);
});

test('成功过且没失败：仍然不产生「上次失败」（详情页不该出现空框）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastAttemptAt: '2026-09-18T03:00:00.000Z',
    lastSuccessAt: '2026-09-18T03:00:12.000Z',
  });

  assert.equal(summary.failedAt, null, '没失败过就不能显示失败行');
  assert.equal(summary.failureReason, null);
});

test('成功晚于失败：不再显示上次失败（最新一次是成功）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastErrorAt: '2026-09-18T02:00:30.000Z',
    lastErrorMessage: 'WebDAV upload timed out after 30000 ms',
    // 后端成功时本会清空 lastError*，但归档恢复 / 手工改配置可能带进这种旧状态
    lastSuccessAt: '2026-09-18T03:00:12.000Z',
  });

  assert.equal(summary.failedAt, null, '成功之后不能让过时的失败信息继续占着列表与详情页');
  assert.equal(summary.failureReason, null);
});

test('失败晚于成功：仍然显示（这就是「一直在重试、一直失败」）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastSuccessAt: '2026-09-18T02:00:12.000Z',
    lastErrorAt: '2026-09-18T03:00:30.000Z',
    lastErrorMessage: 'WebDAV upload timed out after 30000 ms',
  });

  assert.match(summary.failedAt ?? '', /^Last failure: /);
  assert.match(summary.failureReason ?? '', /30s/);
});

test('时间无法解析时保持显示（宁可多提示一次，也不把真实失败藏起来）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastErrorAt: 'not-a-date',
    lastErrorMessage: 'S3 upload timed out after 5000 ms',
    lastSuccessAt: '2026-09-18T03:00:12.000Z',
  });

  assert.match(summary.failedAt ?? '', /^Last failure: /);
  assert.match(summary.failureReason ?? '', /5s/);
});

test('失败过：同时给出失败时间与原因（命中映射的超时文案会被本地化）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastAttemptAt: '2026-09-18T03:05:00.000Z',
    lastSuccessAt: '2026-09-18T03:00:12.000Z',
    lastErrorAt: '2026-09-18T03:05:30.000Z',
    lastErrorMessage: 'WebDAV upload timed out after 30000 ms',
  });

  assert.match(summary.failedAt ?? '', /^Last failure: /);
  assert.match(
    summary.failureReason ?? '',
    /30s/,
    '超时文案有专门的映射（毫秒换算成秒）：命中映射才是本地化过的文案'
  );
});

test('未命中映射的原因保留原文（不回落到通用文案）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastErrorAt: '2026-09-18T03:05:30.000Z',
    lastErrorMessage: 'S3 putObject failed: 403',
  });

  assert.equal(summary.failureReason, 'S3 putObject failed: 403');
});

test('只有空白字符的原因不算失败（避免渲染出空的失败行）', () => {
  const summary = getDestinationRuntimeSummary({
    ...createDefaultBackupRuntimeState(),
    lastErrorAt: '2026-09-18T03:05:30.000Z',
    lastErrorMessage: '   ',
  });

  assert.equal(summary.failedAt, null);
  assert.equal(summary.failureReason, null);
});

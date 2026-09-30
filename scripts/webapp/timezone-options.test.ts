// 时区下拉的选项构建 + 源码护栏（思路同 locale-options.test.ts）。
// 破了不报错，只在用户侧添堵：「自动」括号跟着手选的时区变、418 项里翻半天找不到自己的。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildTimezoneGroups, formatTimezoneOption } from '../../webapp/src/lib/timezone-options';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const ZONES = ['Africa/Abidjan', 'Africa/Accra', 'America/New_York', 'Asia/Shanghai', 'Europe/London'];

test('按 IANA 地区分组，组内保持传入顺序（ICU 的字母序）', () => {
  const { groups } = buildTimezoneGroups(ZONES, 'Asia/Shanghai');
  assert.deepEqual(groups.map((group) => group.region), ['Africa', 'America', 'Europe']);
  assert.deepEqual(groups[0].options.map((option) => option.value), ['Africa/Abidjan', 'Africa/Accra']);
  assert.deepEqual(groups[1].options.map((option) => option.value), ['America/New_York']);
});

test('探测到的时区单独一条，且不在分组里重复出现', () => {
  const { detectedOption, groups } = buildTimezoneGroups(ZONES, 'Europe/London');
  assert.equal(detectedOption?.value, 'Europe/London');
  const grouped = groups.flatMap((group) => group.options).map((option) => option.value);
  assert.equal(grouped.includes('Europe/London'), false, '探测项已单独一条，分组里不得再出现');
  assert.equal(new Set(grouped).size, grouped.length, '不得有重复 value');
  assert.equal(grouped.length, ZONES.length - 1, '选项总数 = 原列表 - 探测项');
});

test('标签带偏移注释，且写成 UTC 而不是 ICU 的 GMT', () => {
  // 只用没有夏令时的时区断言：有 DST 的（如 Europe/London）偏移随季节变，断言会随日期飘。
  assert.equal(formatTimezoneOption('Asia/Shanghai').label, 'Asia/Shanghai (UTC+8)');
  assert.match(formatTimezoneOption('Asia/Kathmandu').label, /\(UTC\+5:45\)$/);
});

test('探测值不在列表里时不凭空插一条（列表可以不含 UTC）', () => {
  const { detectedOption, groups } = buildTimezoneGroups(['Africa/Abidjan'], 'UTC');
  assert.equal(detectedOption, null);
  assert.deepEqual(groups.map((group) => group.region), ['Africa']);
});

test('不改动传入的数组（纯函数）', () => {
  const input = [...ZONES];
  buildTimezoneGroups(input, 'Europe/London');
  assert.deepEqual(input, ZONES);
});

test('「自动」括号用时区探测值，不得用服务端保存的当前时区', () => {
  const source = readSource('webapp/src/components/SettingsPage.tsx');
  assert.match(source, /const detectedTimezone = detectBrowserTimeZone\(\);/, '要有独立的探测值');
  assert.doesNotMatch(
    source,
    /props\.mailPreferences\?\.timezone \?\? detectBrowserTimeZone\(\)/,
    '不得拿服务端当前时区当自动值 —— 手动切时区后括号会跟着变'
  );
  assert.match(source, /buildTimezoneGroups\(timezoneOptions, detectedTimezone\)/, '分组要由 buildTimezoneGroups 决定');
  assert.match(source, /<optgroup key=\{group\.region\} label=\{group\.region\}>/, '要按地区渲染 optgroup');
});

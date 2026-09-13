// 消除 CodeQL `js/polynomial-redos` 告警的回归测试。
//
// 背景：CodeQL 报了 5 条 high —— "尾部量词正则作用在长串同一字符上可能变慢"
// （`/=+$/`、`/\/+$/`、`/\.+$/`、`/^\/+|\/+$/g`）。这些正则本身是线性扫描，
// 但审计噪音不值得长期挂着，因此全部改成**显式循环**。改了就必须证明"语义没变"，
// 否则这类改动最容易悄悄改变规范化结果（域名规范化直接影响域名规则的匹配）。
//
// 本文件做三件事：
// 1. 特征化断言：循环实现与"被替换掉的正则链"在一批含恶意长串的输入上结果完全一致
// 2. 端到端断言：公开入口 `normalizeEquivalentDomain` 对超长恶意输入是线性的、结果正确
// 3. 源码护栏：那 4 个文件里不允许再出现尾部量词正则（防止回退）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeEquivalentDomain } from '../shared/domain-normalize';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** 被替换掉的原实现（仅用于特征化对比，不要在产品代码里用） */
const legacyTrimLeadingStarsAndDots = (raw: string): string =>
  raw.replace(/^\*+\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
const legacyTrimSlashes = (raw: string): string => raw.replace(/^\/+|\/+$/g, '');
const legacyTrimTrailingSlashes = (raw: string): string => raw.replace(/\/+$/, '');
const legacyTrimBase64Padding = (raw: string): string => raw.replace(/=+$/g, '');

/** 新实现（与产品代码逐字对应） */
function trimLeadingStarsAndDots(raw: string): string {
  let start = 0;
  let stars = 0;
  while (start + stars < raw.length && raw[start + stars] === '*') stars += 1;
  if (stars > 0 && raw[start + stars] === '.') start += stars + 1;
  while (start < raw.length && raw[start] === '.') start += 1;
  let end = raw.length;
  while (end > start && raw[end - 1] === '.') end -= 1;
  return raw.slice(start, end);
}

function trimSlashes(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw[start] === '/') start += 1;
  while (end > start && raw[end - 1] === '/') end -= 1;
  return raw.slice(start, end);
}

function trimTrailingSlashes(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '/') end -= 1;
  return raw.slice(0, end);
}

function trimBase64Padding(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '=') end -= 1;
  return raw.slice(0, end);
}

// 含"边界形态"与"恶意长串"：长串才是 CodeQL 关心的场景，必须一起对比
const HOST_CORPUS = [
  'example.com',
  '*.example.com',
  '**..EXAMPLE.com..',
  '.example.com',
  '..example.com..',
  '*example.com',
  '*.*.a.b',
  'a.',
  '.a',
  '...',
  '*',
  '**',
  '*.',
  '*.a.',
  '....a....',
  '***...a.b...',
  '*'.repeat(50) + '.' + '.'.repeat(50) + 'example.com' + '.'.repeat(50),
  '*'.repeat(200_000) + 'x',
  '.'.repeat(200_000) + 'a',
  'a' + '.'.repeat(200_000),
  '*'.repeat(100_000) + '.' + '.'.repeat(100_000) + 'a' + '.'.repeat(100_000),
];

test('尾部裁剪：循环实现与被替换的正则链在全部输入上结果一致', () => {
  for (const input of HOST_CORPUS) {
    assert.equal(
      trimLeadingStarsAndDots(input),
      legacyTrimLeadingStarsAndDots(input),
      `星号/点号裁剪不一致：${JSON.stringify(input.slice(0, 40))}…`
    );
  }

  for (const input of ['', '/', '//', '/a/', '///a///', '/'.repeat(100_000), '/'.repeat(50_000) + 'a' + '/'.repeat(50_000)]) {
    assert.equal(trimSlashes(input), legacyTrimSlashes(input), `首尾斜杠裁剪不一致：${JSON.stringify(input.slice(0, 40))}…`);
    assert.equal(
      trimTrailingSlashes(input),
      legacyTrimTrailingSlashes(input),
      `尾部斜杠裁剪不一致：${JSON.stringify(input.slice(0, 40))}…`
    );
  }

  for (const input of ['', '=', '==', 'ab==', 'a=b=c', 'x' + '='.repeat(100_000)]) {
    assert.equal(
      trimBase64Padding(input),
      legacyTrimBase64Padding(input),
      `base64 填充裁剪不一致：${JSON.stringify(input.slice(0, 40))}…`
    );
  }
});

test('normalizeEquivalentDomain：超长恶意输入仍是线性、且与干净输入等价', () => {
  const clean = normalizeEquivalentDomain('example.com');

  // 裁剪之后是合法域名 ⇒ 必须与干净输入给出完全相同的结果
  const trimmableToValid = [
    '.'.repeat(300_000) + 'example.com',
    'example.com' + '.'.repeat(300_000),
    '*'.repeat(300_000) + '.example.com',
    '*'.repeat(50_000) + '.example.com' + '.'.repeat(50_000),
  ];
  for (const hostile of trimmableToValid) {
    const started = performance.now();
    const normalized = normalizeEquivalentDomain(hostile);
    const elapsed = performance.now() - started;
    assert.equal(normalized, clean, '恶意长串必须被规范化成与干净输入相同的结果');
    // 线性扫描在 30 万字符上是毫秒级；给 2 秒的宽松上界，只用来抓"回溯爆炸"级别的退化
    assert.ok(elapsed < 2000, `规范化耗时异常：${elapsed.toFixed(1)} ms`);
  }

  // 裁剪之后仍非法（星号后面不是点号，按既有语义星号要保留 ⇒ 域名非法）
  // ⇒ 只断言"很快且不抛错"，不锁定具体值，避免把 URL 解析器的细节写进断言
  for (const hostile of ['*.'.repeat(100_000) + 'example.com', '*'.repeat(300_000) + 'example.com']) {
    const started = performance.now();
    const normalized = normalizeEquivalentDomain(hostile);
    const elapsed = performance.now() - started;
    assert.equal(typeof normalized, 'string');
    assert.ok(elapsed < 2000, `规范化耗时异常：${elapsed.toFixed(1)} ms`);
  }
});

test('源码护栏：这些文件里不允许再出现尾部量词正则（防止 CodeQL 告警回退）', () => {
  // 必须先剥掉注释再扫：这些文件里恰好**在注释中**引用了被替换掉的正则原文
  // （"用显式循环代替 /^\\*+\\./ ……"），否则护栏会自己把自己判违规。
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');

  const guarded: ReadonlyArray<readonly [string, RegExp]> = [
    ['shared/domain-normalize.ts', /\/\^\\\*\+\\\.\//],
    ['src/handlers/backup.ts', /\/\^\\\/\+\|\\\/\+\$\//],
    ['src/services/backup-uploader.ts', /\/\\\/\+\$\//],
    ['src/utils/account-passkeys.ts', /\/=\+\$\//],
  ];
  for (const [relative, pattern] of guarded) {
    const source = stripComments(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
    assert.doesNotMatch(source, pattern, `${relative} 又出现了尾部量词正则，请改回显式循环`);
  }
});

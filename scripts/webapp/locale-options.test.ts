// 语言下拉的选项构建 + 两条源码护栏。
// 破了都不报错，只在用户侧制造障碍：界面是英文时认不出自己的语言在别人那里叫什么，
// 或者「自动」括号里显示成临时手选的语言（让人以为选自动只会切到那个语言）。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AVAILABLE_LOCALES } from '../../webapp/src/lib/i18n';
import { buildLocaleOptions } from '../../webapp/src/lib/locale-options';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('探测出的语言排在最前，且不在其余选项里重复', () => {
  for (const detected of ['zh-CN', 'en', 'sv', 'ru'] as const) {
    const options = buildLocaleOptions(detected);
    assert.equal(options[0].value, detected, `${detected} 应排第一`);
    assert.equal(options.length, AVAILABLE_LOCALES.length, '选项总数不该变');
    assert.equal(new Set(options.map((option) => option.value)).size, options.length, '不得有重复 value');
    assert.deepEqual(
      options.slice(1).map((option) => option.value),
      AVAILABLE_LOCALES.filter((option) => option.value !== detected).map((option) => option.value),
      '其余语言必须保持 AVAILABLE_LOCALES 的相对顺序'
    );
  }
});

test('语言名用语言自己的写法（不按界面语言翻译）', () => {
  const labels = new Map(buildLocaleOptions('zh-CN').map((option) => [option.value, option.label]));
  assert.equal(labels.get('zh-CN'), '简体中文');
  assert.equal(labels.get('zh-TW'), '繁體中文');
  assert.equal(labels.get('en'), 'English');
  assert.equal(labels.get('ru'), 'Русский');
});

test('「自动」括号用探测值，与当前手选的语言脱钩', () => {
  const source = readSource('webapp/src/components/SettingsPage.tsx');
  assert.match(source, /const detectedLocale = detectBrowserLocale\(\);/, '要有独立的探测值');
  assert.match(source, /localeLabel\(detectedLocale\)/, '「自动」括号必须用探测值');
  assert.doesNotMatch(
    source,
    /props\.mailPreferences\?\.locale \?\? detectBrowserLocale\(\)/,
    '不得再拿「服务端保存的当前语言」当自动值 —— 手动切语言后括号会跟着变'
  );
});

test('下拉把探测语言提到第二位，选项文本用语言自己的写法', () => {
  const source = readSource('webapp/src/components/SettingsPage.tsx');
  const block = source.match(/buildLocaleOptions\(detectedLocale\)\.map\([\s\S]{0,200}?\)\)/);
  assert.ok(block, '未能从 SettingsPage 抽到下拉选项块 —— 写法变了，本护栏要跟着改');
  assert.match(block[0], /\{option\.label\}/, '选项文本必须是语言自己的写法');
  assert.doesNotMatch(block[0], /t\(/, '不得把语言名按界面语言翻译');
});

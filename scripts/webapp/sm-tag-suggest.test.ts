// 标签候选的筛选（`webapp/src/lib/sm-tag-suggest.ts`）：
// 空输入给全部候选（这是「省去手敲」而不是「自动补全」）；匹配忽略大小写，但候选本身大小写敏感。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { filterTagSuggestions } from '../../webapp/src/lib/sm-tag-suggest';

const OPTIONS = ['Prod', 'prod', '测试', '生产'];

test('空输入 / 纯空白：给全部候选（点一下即填）', () => {
  assert.deepEqual(filterTagSuggestions(OPTIONS, ''), OPTIONS);
  assert.deepEqual(filterTagSuggestions(OPTIONS, '   '), OPTIONS);
});

test('按子串匹配（不限位置）', () => {
  assert.deepEqual(filterTagSuggestions(OPTIONS, '测'), ['测试']);
  assert.deepEqual(filterTagSuggestions(OPTIONS, '产'), ['生产']);
  assert.deepEqual(filterTagSuggestions(['apikey-a', 'apikey-b', 'token'], 'key'), ['apikey-a', 'apikey-b']);
});

test('⭐ 匹配忽略大小写：输入 `prod` 时 `Prod` 与 `prod` 都是候选', () => {
  assert.deepEqual(filterTagSuggestions(OPTIONS, 'PROD'), ['Prod', 'prod']);
  assert.deepEqual(filterTagSuggestions(OPTIONS, 'prod'), ['Prod', 'prod']);
});

test('没有匹配 ⇒ 空（面板不显示，用户可以自由输入新标签）', () => {
  assert.deepEqual(filterTagSuggestions(OPTIONS, 'zzz'), []);
  assert.deepEqual(filterTagSuggestions([], 'anything'), []);
});

test('⭐ 唯一候选且与输入相等（含大小写差异）⇒ 不再提示', () => {
  // 已经逐字填好，面板上再挂一个一样的候选只是碍事
  assert.deepEqual(filterTagSuggestions(['测试'], '测试'), []);
  assert.deepEqual(filterTagSuggestions(['Prod'], 'prod'), [], '忽略大小写后相等，同样不再提示');
  // 但候选不止一个时不能吞：另一个可能正是用户要的
  assert.deepEqual(filterTagSuggestions(['测试', '测试环境'], '测试'), ['测试', '测试环境']);
});

test('不改动传入数组', () => {
  const options = ['a', 'b'];
  const result = filterTagSuggestions(options, 'a');
  assert.deepEqual(options, ['a', 'b']);
  assert.notEqual(result, options);
});

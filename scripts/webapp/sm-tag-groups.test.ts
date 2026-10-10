// 按标签分组（`webapp/src/lib/sm-tag-groups.ts`）。
//
// 钉住四条规则（都是「改一行就静默变味」的那种）：
// ① 分组来源是**传进来的条目** ⇒ 结构上不可能出现空组（筛掉某标签的全部条目后，那个标签不再成组）；
// ② 组间按标签名排（`localeCompare`）；组内**保持传入顺序**（调用方的排序不被这里打乱）；
// ③ 无标签的条目单独回给调用方（不参与分组，由界面放到最下面）；
// ④ 标签大小写敏感，只做两端 `trim`（`prod` / `Prod` 两个组；`' p '` 归到 `p`）。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { groupSecretsByTag } from '../../webapp/src/lib/sm-tag-groups';

type Item = { id: string };
const items: Item[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

test('分组：无标签的条目不进组，单独返回', () => {
  const { groups, untagged } = groupSecretsByTag(items, { a: '生产', b: '生产', c: '测试' });
  assert.deepEqual(
    groups.map((group) => [group.tag, group.items.map((item) => item.id)]),
    [
      ['测试', ['c']],
      ['生产', ['a', 'b']],
    ]
  );
  assert.deepEqual(untagged.map((item) => item.id), ['d']);
});

test('⭐ 空组不可能出现：某标签的条目全被筛掉后，该标签不再成组', () => {
  const tags = { a: '生产', b: '测试' };
  // 模拟「筛项目 / 搜索」后只剩 a
  const { groups } = groupSecretsByTag([{ id: 'a' }], tags);
  assert.deepEqual(
    groups.map((group) => group.tag),
    ['生产'],
    '分组只从传进来的条目聚合 ⇒ 不该出现只有标题没有内容的「测试」组'
  );
});

test('组间按标签名排（localeCompare），组内保持传入顺序', () => {
  const { groups } = groupSecretsByTag(
    [{ id: 'z1' }, { id: 'a1' }, { id: 'b1' }, { id: 'a2' }],
    { z1: 'zeta', a1: 'alpha', b1: 'alpha', a2: 'alpha' }
  );
  assert.deepEqual(groups.map((group) => group.tag), ['alpha', 'zeta']);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['a1', 'b1', 'a2'], '组内顺序 = 传入顺序');
});

test('大小写敏感 + 两端 trim（只做这一项卫生处理）', () => {
  const { groups, untagged } = groupSecretsByTag(
    [{ id: 'x' }, { id: 'y' }, { id: 'z' }, { id: 'blank' }],
    { x: 'Prod', y: 'prod', z: ' p ', blank: '   ' }
  );
  // `localeCompare` 默认「大小写不敏感优先、同一字母小写在前」⇒ 只要断言三者都成组、且没被合并。
  assert.deepEqual(groups.map((group) => group.tag), ['p', 'prod', 'Prod']);
  assert.equal(new Set(groups.map((group) => group.tag)).size, 3, '`Prod` 与 `prod` 必须是两个组');
  assert.deepEqual(untagged.map((item) => item.id), ['blank'], '只有空白 = 没打标签');
  assert.equal(groups.find((group) => group.tag === 'p')?.items[0].id, 'z', '两端空白被去掉');
});

test('空列表 / 全无标签：不崩，组为空、全部落到未标记', () => {
  assert.deepEqual(groupSecretsByTag([], {}), { groups: [], untagged: [] });
  const { groups, untagged } = groupSecretsByTag(items, {});
  assert.deepEqual(groups, []);
  assert.equal(untagged.length, items.length);
});

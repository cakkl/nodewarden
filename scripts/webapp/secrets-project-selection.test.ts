// 「调整所属项目」对话框的勾选语义：多选机密时**逐项目三态 + 增量**。
// 关键约束：用户没动过的项目必须保持各条原样（只有 A 属于 B、用户没碰 B ⇒ 仍然只有 A 属于 B）。
// 运行方式：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  applyProjectToggles,
  commonProjectIds,
  projectCheckState,
} from '../../webapp/src/lib/secrets-project-selection';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NONE = new Map<string, boolean>();

test('三态：都不属于 ⇒ 不勾；都属于 ⇒ 全勾；部分属于 ⇒ 半勾', () => {
  const selected = [{ id: 's1', projectIds: ['p1'] }, { id: 's2', projectIds: ['p1', 'p2'] }];
  assert.equal(projectCheckState(selected, 'p1', NONE), true, '两条都含 p1');
  assert.equal(projectCheckState(selected, 'p2', NONE), 'partial', '只有 s2 含 p2');
  assert.equal(projectCheckState(selected, 'p3', NONE), false, '两条都不含 p3');
});

test('用户动过的项目以勾选结果为准（半勾点一下 → 全勾）', () => {
  const selected = [{ id: 's1', projectIds: ['p1'] }, { id: 's2', projectIds: ['p1', 'p2'] }];
  assert.equal(projectCheckState(selected, 'p2', new Map([['p2', true]])), true);
  assert.equal(projectCheckState(selected, 'p1', new Map([['p1', false]])), false);
});

test('勾选 ⇒ 给所有涉及的机密加上；取消 ⇒ 从所有涉及的机密移除', () => {
  const selected = [{ id: 's1', projectIds: ['p1'] }, { id: 's2', projectIds: ['p1', 'p2'] }];

  assert.deepEqual(applyProjectToggles(selected, new Map([['p2', true]])), [
    { id: 's1', projectIds: ['p1', 'p2'] },
    { id: 's2', projectIds: ['p1', 'p2'] },
  ]);
  assert.deepEqual(applyProjectToggles(selected, new Map([['p1', false]])), [
    { id: 's1', projectIds: [] },
    { id: 's2', projectIds: ['p2'] },
  ]);
});

test('⭐ 没动过的项目保持不变（只有 A 属于 B ⇒ 没碰 B 就仍然只有 A 属于 B）', () => {
  const selected = [{ id: 'A', projectIds: ['B'] }, { id: 'C', projectIds: [] }];
  assert.deepEqual(applyProjectToggles(selected, NONE), [
    { id: 'A', projectIds: ['B'] },
    { id: 'C', projectIds: [] },
  ]);
  // 动别的项目也不该波及 B
  assert.deepEqual(applyProjectToggles(selected, new Map([['D', true]])), [
    { id: 'A', projectIds: ['B', 'D'] },
    { id: 'C', projectIds: ['D'] },
  ]);
});

test('标签：结果一致时给集合，不一致给 null（显示「多个项目」）', () => {
  assert.deepEqual(commonProjectIds([{ projectIds: ['p2', 'p1'] }, { projectIds: ['p1', 'p2'] }]), ['p2', 'p1']);
  assert.equal(commonProjectIds([{ projectIds: ['p1'] }, { projectIds: [] }]), null);
  assert.deepEqual(commonProjectIds([]), []);
});

test('页面：一个都没动时不发请求（结果本来就没变化）', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'webapp/src/components/SecretsPage.tsx'), 'utf8');
  const start = source.indexOf('function runSetProjects(');
  assert.notEqual(start, -1, '找不到 runSetProjects');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /if \(projectToggles\.size === 0\)/, '没动过要先判断');
  assert.ok(
    body.indexOf('projectToggles.size === 0') < body.indexOf('onSetSecretsProjects'),
    '判断必须在调用之前'
  );
});

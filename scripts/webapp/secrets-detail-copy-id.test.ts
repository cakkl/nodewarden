// 详情页「复制」按钮（复制的是机密 id）的护栏。
//
// 这条按钮的**唯一**价值就是给出那个 id —— `bws secret get <id>` 那类命令的入参。
// 一旦改成复制名称 / 值（看起来同样「能复制」），拿到的东西在 CLI 上不好使，而界面上不报错。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

test('详情页的复制按钮复制的是机密 id，且复用统一的剪贴板工具', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'webapp/src/components/SecretsPage.tsx'), 'utf8');

  assert.match(
    source,
    /copyTextToClipboard\(selected\.id\)/,
    '必须复制 `selected.id`；改成名称 / 值在界面上看不出来，但 CLI 用不了'
  );
  assert.match(
    source,
    /import \{ copyTextToClipboard \} from '@\/lib\/clipboard'/,
    '走 `lib/clipboard` 的统一实现（它自带「已复制 / 复制失败」提示）'
  );
  // 复制排在「编辑」之后（同一组非破坏性动作；删除在另一侧）。
  // ⚠️ 不能用 `indexOf('detail-actions')` 定位：第一处命中的是**编辑器**那一组。
  const copyIndex = source.indexOf('copyTextToClipboard(selected.id)');
  const editIndex = source.indexOf('onClick={openEdit}');
  assert.ok(copyIndex > 0 && editIndex > 0, '两个按钮都应在详情页里');
  assert.ok(editIndex < copyIndex, '复制按钮挨在「编辑」旁（排在它后面）');
});

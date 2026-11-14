// 文件夹树构建的测试。
//
// 服务端只存加密后的完整名称，`/` 分层完全靠客户端推断（见 `webapp/src/lib/folder-tree.ts`）。
// 这里的断言守住三条不变量：
//   1. **任何文件夹都不能丢** —— 父级缺失、重名、首尾斜杠都只影响「挂在哪」，不影响「在不在」。
//   2. 只有「存在且完全匹配」的父名才产生嵌套，靠猜（前缀相似、大小写不同）一律不嵌套。
//   3. 折叠只隐藏子节点，自身仍然渲染；遍历用迭代而非递归，深层路径不会爆栈。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFolderTree, flattenFolderTree } from '../../webapp/src/lib/folder-tree';
import type { Folder } from '../../webapp/src/lib/types';

function folder(id: string, name: string): Folder {
  return { id, name, decName: name };
}

/** 收集所有叶子/根节点的完整路径，便于断言结构。 */
function paths(roots: ReturnType<typeof buildFolderTree>): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof buildFolderTree>, prefix: string) => {
    for (const node of nodes) {
      const path = prefix ? `${prefix}/${node.label}` : node.label;
      out.push(path);
      walk(node.children, path);
    }
  };
  walk(roots, '');
  return out.sort();
}

test('斜杠分隔的名称挂到已存在的父级下，并只显示最后一段', () => {
  const roots = buildFolderTree([
    folder('1', 'Work'),
    folder('2', 'Work/Email'),
    folder('3', 'Work/Email/Newsletter'),
  ]);

  assert.equal(roots.length, 1);
  assert.equal(roots[0].label, 'Work');
  assert.deepEqual(paths(roots), ['Work', 'Work/Email', 'Work/Email/Newsletter']);
});

test('父级不存在时保持顶层，但节点本身必须保留', () => {
  const roots = buildFolderTree([folder('1', 'Missing/Parent'), folder('2', 'Other')]);

  // 两者都在顶层：`Missing` 没建过，所以 `Missing/Parent` 不嵌套，但不会被丢弃。
  assert.deepEqual(roots.map((node) => node.folder.id).sort(), ['1', '2']);
  assert.deepEqual(paths(roots), ['Missing/Parent', 'Other']);
});

test('重名文件夹只认第一个作为父级，其余同级保留', () => {
  const roots = buildFolderTree([
    folder('1', 'Work'),
    folder('2', 'Work'),
    folder('3', 'Work/Email'),
  ]);

  // 顶层两个 Work，子项挂在第一个下 —— 关键是三个 id 一个不少。
  const topIds = roots.map((node) => node.folder.id).sort();
  assert.deepEqual(topIds, ['1', '2']);
  const withChildren = roots.filter((node) => node.children.length > 0);
  assert.equal(withChildren.length, 1);
  assert.equal(withChildren[0].children[0].folder.id, '3');
});

test('开头或结尾的斜杠不产生嵌套', () => {
  const roots = buildFolderTree([folder('1', '/Lead'), folder('2', 'Trail/')]);

  assert.deepEqual(roots.map((node) => node.folder.id).sort(), ['1', '2']);
  // 名称原样保留，不做裁剪 —— 裁掉就成了另一个名字，用户会看到自己没取过的名字。
  assert.deepEqual(paths(roots), ['/Lead', 'Trail/']);
});

test('flattenFolderTree 按前序展开并给出层级深度', () => {
  const roots = buildFolderTree([
    folder('1', 'Work'),
    folder('2', 'Work/Email'),
    folder('3', 'Work/Email/Newsletter'),
  ]);
  const rows = flattenFolderTree(roots, new Set());

  assert.deepEqual(
    rows.map((row) => [row.folder.id, row.depth]),
    [
      ['1', 0],
      ['2', 1],
      ['3', 2],
    ]
  );
});

test('折叠父节点只隐藏子节点，父节点自身仍在结果里', () => {
  const roots = buildFolderTree([folder('1', 'Work'), folder('2', 'Work/Email')]);
  const rows = flattenFolderTree(roots, new Set(['1']));

  assert.deepEqual(rows.map((row) => row.folder.id), ['1']);
});

test('深层路径不因递归而爆栈', () => {
  // 1000 层：递归实现会在这里 RangeError。
  let name = 'L0';
  const folders = [folder('0', name)];
  for (let i = 1; i <= 1000; i++) {
    name = `${name}/L${i}`;
    folders.push(folder(String(i), name));
  }

  const rows = flattenFolderTree(buildFolderTree(folders), new Set());
  assert.equal(rows.length, 1001);
  assert.equal(rows[1000].depth, 1000);
});

// 详情面板「改完不刷新」的护栏：列表端点不含 value / note（官方契约），详情单独取
// ⇒ 只刷列表不够，选中那条也要重取。运行：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 取 `const <name> = useCallback(` 到它自己的依赖数组为止的片段。 */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `找不到 ${name} 的定义`);
  const end = source.indexOf('\n  }, [', start);
  assert.notEqual(end, -1, `找不到 ${name} 的依赖数组`);
  return source.slice(start, end);
}

test('refresh 必须一并重取选中机密的详情', () => {
  const body = callbackBody(readSource('webapp/src/hooks/useSecretsManager.ts'), 'refresh');
  assert.match(
    body,
    /await loadDetail\(/,
    'refresh 里必须重取选中项 —— 列表没有 value / note，改完项目 / 备注不重取就会停在旧值'
  );
  assert.match(
    body,
    /selectedIdRef\.current/,
    '要用 ref 读选中项：直接进依赖会让 refresh 的标识随选中变化，每点一次条目都重拉一遍列表'
  );
  assert.match(body, /listed\.secrets\.some\(/, '重取前要先确认它还在列表里（被删 / 被筛掉的不要拉）');
});

test('单条还原后要清掉回收站选中项', () => {
  const source = readSource('webapp/src/components/SecretsPage.tsx');
  const offenders = [...source.matchAll(/onClick=\{\(\) => void onRestoreTrash\(\[trashSelected\.id\]\)\}/g)]
    .length;
  assert.equal(
    offenders,
    0,
    '单条还原前必须先 setTrashSelectedId(null)，否则面板会留着已还原的那条（连同已经失效的按钮）'
  );
});

// 列表刷新不该闪空：加载 / 错误占位只能在**列表为空**时出现，否则点「同步」或收到实时推送会让
// 列表先变「加载中」再回来。密码库与 Send 页本来就这么写，这里盯住两个机密页面。
// 运行：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const CASES = [
  {
    file: 'webapp/src/components/SecretsPage.tsx',
    loading: /manager\.loading && !listItems\.length/,
    error: /manager\.error && !listItems\.length/,
  },
  {
    file: 'webapp/src/components/MachineAccountsPage.tsx',
    loading: /loading && !accounts\.length/,
    error: /error && !accounts\.length/,
  },
];

for (const item of CASES) {
  test(`${item.file} 的加载 / 错误占位限定在列表为空时`, () => {
    const source = readSource(item.file);
    assert.match(
      source,
      item.loading,
      '要写成「loading && !<列表>.length」：有数据时刷新（同步 / 实时推送）必须保持列表可见'
    );
    assert.match(
      source,
      item.error,
      '错误占位同样要限定在列表为空时，否则刷新失败会把已有列表顶掉'
    );
  });
}

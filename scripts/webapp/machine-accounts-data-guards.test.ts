// 机器账号页的数据必须挂在 App 上（与机密页一致），不能在页面里加载：
// 页面随路由卸载，回到本页会先清空再加载（列表闪一下「加载中」）。
// 运行方式：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('机器账号数据由 App 提供，页面不再自己加载', () => {
  assert.match(
    readSource('webapp/src/App.tsx'),
    /useMachineAccounts\(/,
    'App 必须调用 useMachineAccounts —— 否则每次进页面都会重新加载'
  );

  const page = readSource('webapp/src/components/MachineAccountsPage.tsx');
  for (const forbidden of ['ensureSecretsContext(', 'listMachineAccounts(', 'listSecretProjects(']) {
    assert.ok(
      !page.includes(forbidden),
      `页面不得自己取数据（发现 ${forbidden}）：数据加载要留在 useMachineAccounts 里`
    );
  }
  assert.match(page, /manager\.onReload\(\)/, '写操作成功后要经 manager 刷新，别再调本地 load');
});

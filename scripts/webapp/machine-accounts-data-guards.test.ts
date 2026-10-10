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
  // 写完就地打补丁，不再整页重拉 —— 整页重拉是 4 + N 个请求（每个账号各一次令牌），
  // 写完等它回来会明显卡顿，与密码库「请求成功后就地更新列表」也不一致。
  assert.ok(
    !/reload: manager\.onReload/.test(page),
    '`useActionRunner` 的 reload 不得再挂在整页重拉上：用 manager 的补丁接口就地更新'
  );
  assert.match(page, /manager\.onUpsertAccount\(/, '名称 / 授权保存后就地更新那一条');
});

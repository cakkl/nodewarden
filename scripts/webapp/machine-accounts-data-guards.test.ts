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

test('令牌随账号列表一起回，不再按账号各发一次（N+1）', () => {
  const hook = readSource('webapp/src/hooks/useMachineAccounts.ts');
  assert.match(
    hook,
    /const \[\{ accounts: nextAccounts, tokens: nextTokens \}, nextProjects\]/,
    'reload 要用列表响应里的令牌，而不是按账号各发一次'
  );
  assert.match(hook, /setTokens\(nextTokens\)/);
  assert.equal(
    (hook.match(/await listMachineAccountTokens\(/g) ?? []).length,
    1,
    '单账号端点只留「吊销后重取那一个账号」这一处'
  );

  const api = readSource('webapp/src/lib/api/secrets.ts');
  assert.match(api, /tokens\?: Record<string, RawToken\[\]>/, '列表端点响应要解出 tokens');
  assert.match(
    readSource('src/handlers/secrets-machine.ts'),
    /listAccessTokensByMachineAccounts/,
    '服务端要一次取全部账号的令牌'
  );
  assert.match(
    readSource('src/services/storage-secrets-token-repo.ts'),
    /machine_account_id IN \(/,
    '用一条 IN 查询，不要按账号逐个查'
  );
});

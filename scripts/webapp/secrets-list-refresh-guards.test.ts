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

// 实时推送细分：服务端的 `kind` 决定收端要重取什么。号段在 durable 与 `App.tsx` 里**各写一份**，
// 收端分支在 hook 里 —— 任何一处漂了都表现为「某类变更静默不刷新」或「白拉一次整表标签」。
test('推送细分：机密集合变更不重取标签，标签变更才重取', () => {
  const hub = readSource('src/durable/notifications-hub.ts');
  const app = readSource('webapp/src/App.tsx');
  const hook = readSource('webapp/src/hooks/useSecretsManager.ts');

  // 号段两侧必须一致（这几个号是本站自有的，官方 SM 只有拉取式同步）
  for (const source of [hub, app]) {
    assert.match(source, /SIGNALR_UPDATE_TYPE_SM_SECRETS = 103;/);
    assert.match(source, /SIGNALR_UPDATE_TYPE_SM_MACHINE_ACCOUNTS = 104;/);
    assert.match(source, /SIGNALR_UPDATE_TYPE_SM_SECRETS_TAGS = 105;/);
  }

  // 收端三类都要认：漏一类 ⇒ 那类变更静默不刷新
  assert.match(app, /updateType === SIGNALR_UPDATE_TYPE_SM_SECRETS_TAGS\b/);
  assert.match(app, /'secrets-tags'/);
  assert.match(hook, /if \(kind === 'machine-accounts'\) return;/);
  assert.match(
    hook,
    /void refresh\(kind === 'secrets' \? \{ skipTags: true \} : undefined\)/,
    '只有「集合变了」能跳过标签；`secrets-tags` 必须走完整刷新'
  );
});

test('推送细分：恢复回收站推的是「标签变了」', () => {
  const secrets = readSource('src/handlers/secrets.ts');
  const restoreAt = secrets.indexOf('SmEventType.SecretRestored');
  assert.ok(restoreAt > 0, '没找到恢复回收站的广播（改名了就要更新这条护栏）');
  assert.match(
    secrets.slice(Math.max(0, restoreAt - 800), restoreAt),
    /kind: 'secrets-tags'/,
    '软删不清标签 ⇒ 恢复回来的条目要回到原本的分组里，必须让收端重取标签'
  );
});

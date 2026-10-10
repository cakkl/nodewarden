// 事件文案不能把机器账号事件的名字落到破折号：机密 / 项目事件用解密后的名字（服务端只放密文），
// 而机器账号类事件的目标就是本页这个账号 —— 名字是明文、事件负载里没有，必须用页面手里的那份，
// 否则会显示成「新建了机器账号「—」」。运行：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PAGE = 'webapp/src/components/MachineAccountsPage.tsx';

test('机器账号事件的文案用账号自己的名字，而不是破折号', () => {
  const source = readFileSync(path.join(REPO_ROOT, PAGE), 'utf8');
  const start = source.indexOf('function eventLabel(');
  assert.notEqual(start, -1, '找不到 eventLabel');
  const body = source.slice(start, source.indexOf('\n}', start));

  assert.match(body, /accountName/, 'eventLabel 必须接收账号名');
  assert.match(body, /event\.secretId \|\| event\.projectId/, '要按「目标是不是机密 / 项目」分支');
  assert.match(body, /: accountName/, '目标是机器账号的事件必须用账号名，不能落到破折号');
});

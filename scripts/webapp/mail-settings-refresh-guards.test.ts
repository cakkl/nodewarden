// 邮件设置保存后必须刷新两个启动查询（源码文本抽取，无 DOM 依赖）：
// profile 里的 `emailVerification` 决定账户页的徽标 / 「验证邮箱地址」按钮，`/api/config` 的
// `mailDeliveryAvailable` 决定两步登录邮件那一行与提示文案 —— 都不刷新就要整页刷新才生效。
// 运行方式：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

test('保存邮件设置后要刷新 profile 与 /api/config', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'webapp/src/App.tsx'), 'utf8');
  const start = source.indexOf('onMailSettingsSaved:');
  assert.notEqual(start, -1, '找不到 onMailSettingsSaved');
  const block = source.slice(start, source.indexOf('\n    },', start));

  assert.match(block, /profileQuery\.refetch\(\)/, '要刷新 profile —— 账户页徽标看 emailVerification');
  assert.match(block, /serverConfigQuery\.refetch\(\)/, '要刷新 /api/config —— 邮件可用性与提示文案看它');
});

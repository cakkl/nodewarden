// 「邮箱未验证」登录提醒的判定逻辑测试。
//
// 这个判定**错一次就有实际后果**：误报会在服务端根本没配邮件时反复骚扰用户
// （而他什么也做不了）；漏报会让用户不知道「忘记主密码后收不到提示邮件」。
// 所以这里把三态（true / false / 字段缺失）和「只提醒一次」都钉住。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldWarnUnverifiedEmail, setEmailVerificationWarningMuted } from '../../webapp/src/lib/email-verification-warning';

test('未验证 + 尚未提醒过 ⇒ 提醒', () => {
  assert.equal(shouldWarnUnverifiedEmail({ id: 'u1', emailVerified: false }, null), true);
});

test('未验证 + 同一用户已提醒过 ⇒ 不重复提醒（profile 会反复刷新）', () => {
  assert.equal(shouldWarnUnverifiedEmail({ id: 'u1', emailVerified: false }, 'u1'), false);
});

test('未验证 + 提醒过的是别的用户 ⇒ 提醒（换了账号）', () => {
  assert.equal(shouldWarnUnverifiedEmail({ id: 'u2', emailVerified: false }, 'u1'), true);
});

test('已验证 ⇒ 不提醒', () => {
  assert.equal(shouldWarnUnverifiedEmail({ id: 'u1', emailVerified: true }, null), false);
});

test('字段缺失（冷启动的脱敏快照 / 服务端未配邮件）⇒ 不提醒', () => {
  assert.equal(shouldWarnUnverifiedEmail({ id: 'u1' }, null), false);
});

test('profile 为 null ⇒ 不提醒', () => {
  assert.equal(shouldWarnUnverifiedEmail(null, null), false);
});

test('没有 id ⇒ 不提醒（无法记录「已提醒」，宁可不说）', () => {
  assert.equal(shouldWarnUnverifiedEmail({ id: '', emailVerified: false }, null), false);
});

// 「不再提醒」：账户界面关掉后，即使换了账号也不该再弹（按浏览器存，与账号无关）
function withLocalStorage<T>(store: Map<string, string>, run: () => T): T {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    return run();
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
}

test('关掉提醒后不再提醒；重新打开又提醒', () => {
  const store = new Map<string, string>();
  withLocalStorage(store, () => {
    setEmailVerificationWarningMuted(true);
    assert.equal(shouldWarnUnverifiedEmail({ id: 'u1', emailVerified: false }, null), false, '关掉后不该提醒');
    setEmailVerificationWarningMuted(false);
    assert.equal(shouldWarnUnverifiedEmail({ id: 'u1', emailVerified: false }, null), true, '重新打开应恢复提醒');
  });
});

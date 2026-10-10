// 离线失败的**统一口径**的护栏。
//
// 钉住三件事：
// ① `backendUnreachable()` 的判定表（无令牌 = 离线信号 —— 只看 navigator.onLine 会漏掉它）；
// ② ⭐ `authedFetch` 把「连不上」统一成本地化错误：**不许再出现浏览器原文**，且主动中止要透传；
// ③ 解锁后申请持久化存储（不申请的话浏览器可回收离线快照）。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAuthedFetch } from '../../webapp/src/lib/api/auth';
import { OfflineRequestError } from '../../webapp/src/lib/api/shared';
import { t } from '../../webapp/src/lib/i18n';
import {
  backendUnreachable,
  browserReportsOffline,
  recordNodeWardenReachable,
  setCurrentNetworkStatus,
} from '../../webapp/src/lib/network-status';
import { requestPersistentStorage } from '../../webapp/src/lib/pwa';
import type { SessionState } from '../../webapp/src/lib/types';

// `authedFetch` 的重试退避用 `window.setTimeout`；Node 里没有 window（也不该真的等）。
const windowStub = { setTimeout: (fn: () => void) => setTimeout(fn, 0) } as unknown as Window;
Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true, writable: true });

function withOnline(onLine: boolean): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: onLine, configurable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis.navigator, 'onLine', previous);
    else Reflect.deleteProperty(globalThis.navigator, 'onLine');
  };
}

/** 每个用例开头都回到「在线 + 探针未失败」的干净状态（这些是模块级状态）。 */
function resetNetworkStatus(): void {
  recordNodeWardenReachable();
}

test('backendUnreachable: 无令牌本身就是离线信号', () => {
  const restore = withOnline(true);
  resetNetworkStatus();
  try {
    assert.equal(backendUnreachable({ hasAccessToken: true }), false, '在线且有令牌 ⇒ 可达');
    assert.equal(backendUnreachable({ hasAccessToken: false }), true, '没令牌 ⇒ 不可达（离线冷启动）');

    setCurrentNetworkStatus('offline');
    assert.equal(backendUnreachable({ hasAccessToken: true }), true, '探针已判离线 ⇒ 不可达');

    resetNetworkStatus();
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    assert.equal(browserReportsOffline(), true);
    assert.equal(backendUnreachable({ hasAccessToken: true }), true, '浏览器自报离线 ⇒ 不可达');
  } finally {
    resetNetworkStatus();
    restore();
  }
});

test('authedFetch: 无令牌抛本地化的离线错误，而不是密码库口径的文案', async () => {
  resetNetworkStatus();
  const authedFetch = createAuthedFetch(() => ({ email: 'a@b.test' }) as SessionState, () => {});
  await assert.rejects(authedFetch('/api/ciphers'), (error: unknown) => {
    assert.ok(error instanceof OfflineRequestError, '必须是 OfflineRequestError');
    assert.equal((error as Error).message, t('txt_offline_unavailable'));
    assert.ok(!(error as Error).message.includes('Failed to fetch'), '不得把浏览器原文透给用户');
    return true;
  });
});

test('authedFetch: 网络层失败统一成本地化错误（并发起重试）', async () => {
  const restore = withOnline(true);
  resetNetworkStatus();
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  try {
    const authedFetch = createAuthedFetch(
      () => ({ email: 'a@b.test', accessToken: 'token' }) as SessionState,
      () => {}
    );
    await assert.rejects(authedFetch('/api/ciphers', { method: 'POST' }), (error: unknown) => {
      assert.ok(error instanceof OfflineRequestError);
      assert.equal((error as Error).message, t('txt_offline_unavailable'));
      return true;
    });
    assert.equal(attempts, 3, '三次尝试后放弃（与既有重试策略一致）');
  } finally {
    globalThis.fetch = originalFetch;
    resetNetworkStatus();
    restore();
  }
});

test('authedFetch: 主动中止不是离线，必须原样透传', async () => {
  const restore = withOnline(true);
  resetNetworkStatus();
  const originalFetch = globalThis.fetch;
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  globalThis.fetch = (async () => {
    throw aborted;
  }) as typeof fetch;
  try {
    const authedFetch = createAuthedFetch(
      () => ({ email: 'a@b.test', accessToken: 'token' }) as SessionState,
      () => {}
    );
    await assert.rejects(authedFetch('/api/ciphers'), (error: unknown) => {
      assert.equal(error, aborted, '中止必须原样抛出，调用方的 AbortError 判断才有效');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetNetworkStatus();
    restore();
  }
});

test('authedFetch: HTTP 错误照旧返回响应，不被包装成离线', async () => {
  resetNetworkStatus();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 400 })) as typeof fetch;
  try {
    const authedFetch = createAuthedFetch(
      () => ({ email: 'a@b.test', accessToken: 'token' }) as SessionState,
      () => {}
    );
    const response = await authedFetch('/api/ciphers');
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
    resetNetworkStatus();
  }
});

test('密码库写保护必须用统一判定（不许退回只看令牌）', () => {
  // 只看令牌会漏掉「有令牌但网络断了」：写请求真的发出去、三次重试后弹英文原文（真机实测）。
  const source = readFileSync(
    new URL('../../webapp/src/hooks/useVaultSendActions.ts', import.meta.url),
    'utf8'
  );
  assert.match(
    source,
    /const requireOnlineWrite = \(\) => \{\s*if \(!backendUnreachable\(/,
    'requireOnlineWrite 必须用 backendUnreachable 判定'
  );
});

test('requestPersistentStorage: 有存储就申请一次，没有也不报错', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
  try {
    // ① 完全没有 `navigator.storage`（旧浏览器 / Safari 的部分版本）
    Reflect.deleteProperty(globalThis.navigator, 'storage');
    assert.doesNotThrow(() => requestPersistentStorage());

    // ② 有存储 ⇒ 申请一次；重复调用不再申请
    let calls = 0;
    Object.defineProperty(globalThis.navigator, 'storage', {
      value: { persist: async () => { calls += 1; return true; } },
      configurable: true,
    });
    requestPersistentStorage();
    requestPersistentStorage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);

    // ③ 申请被拒绝也不能变成未处理异常
    Object.defineProperty(globalThis.navigator, 'storage', {
      value: { persist: async () => { throw new Error('denied'); } },
      configurable: true,
    });
    assert.doesNotThrow(() => requestPersistentStorage());
  } finally {
    if (previous) Object.defineProperty(globalThis.navigator, 'storage', previous);
    else Reflect.deleteProperty(globalThis.navigator, 'storage');
  }
});

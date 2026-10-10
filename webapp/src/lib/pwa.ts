import { detectPreferredLocales, getLocale, preloadLocaleMessages } from './i18n';

export function registerNodeWardenServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // PWA support is progressive enhancement; the vault still works without it.
    });
    // 用户「清除缓存的图片和文件」会清空 CacheStorage 但保留 SW ⇒ `install` 不会重跑、预缓存
    // 会一直残缺到下次部署。每次加载后让 SW 自查一次，缺什么补什么。
    void navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage({ type: 'nodewarden:ensure-precache' }))
      .catch(() => {
        // 拿不到 `ready`（注册失败 / 被策略拦下）就算了，离线能力是渐进增强。
      });
  };

  if (document.readyState === 'complete') {
    register();
    return;
  }

  window.addEventListener('load', register, { once: true });
}

/** 只做一次（每个页面实例）。 */
let persistentStorageRequested = false;

/**
 * 申请「持久化存储」配额。
 * ⚠️ 离线能力全押在浏览器存储上（两个快照 + 离线解锁记录），不申请就可能在存储紧张时被静默回收。
 * 授权由浏览器决定（Chrome 可能直接拒绝）⇒ 只是尽力而为，不给用户反馈。
 */
export function requestPersistentStorage(): void {
  if (typeof window === 'undefined' || persistentStorageRequested) return;
  const storage = navigator.storage;
  if (!storage || typeof storage.persist !== 'function') return;
  persistentStorageRequested = true;
  void storage.persist().catch(() => {});
}

/** 只做一次（每个页面实例）。 */
let offlineLocalePrefetchScheduled = false;

/**
 * 登录就绪后调用：空闲时把「本机可能用到的其它语言包」抓进缓存。
 *
 * 语言包不在 SW 预缓存清单里（首访少下 ~900 KB），代价是离线时只有用过的语言可用；这一步把该能力补回来。
 */
export function scheduleOfflineLocalePrefetch(): void {
  if (typeof window === 'undefined' || offlineLocalePrefetchScheduled) return;

  const current = getLocale();
  const targets = detectPreferredLocales().filter((locale) => locale !== current && locale !== 'en');
  if (targets.length === 0 || !shouldSpendTrafficOnLocalePrefetch()) return;

  offlineLocalePrefetchScheduled = true;

  const run = () => {
    void (async () => {
      for (const locale of targets) {
        try {
          await preloadLocaleMessages(locale);
        } catch {
          // 预取失败无所谓：用户真切到那个语言时页面会重新请求。
        }
      }
    })();
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 10_000 });
    return;
  }
  window.setTimeout(run, 3_000);
}

/**
 * 只排除「用户显式省流量」与「真的没法用」的网络。
 *
 * ⚠️ 不要把 3g 也列进来：跨境访问的 `effectiveType` 经常就是 3g，那会让预取静默失效
 *（一份语言包才 ~100 KB，且已排在登录之后的空闲回调里）。
 */
function shouldSpendTrafficOnLocalePrefetch(): boolean {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!connection) return true;
  if (connection.saveData === true) return false;
  return !['slow-2g', '2g'].includes(String(connection.effectiveType || ''));
}

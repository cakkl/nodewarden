import { detectPreferredLocales, getLocale, preloadLocaleMessages } from './i18n';

export function registerNodeWardenServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // PWA support is progressive enhancement; the vault still works without it.
    });
  };

  if (document.readyState === 'complete') {
    register();
    return;
  }

  window.addEventListener('load', register, { once: true });
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

export type NetworkStatus = 'online' | 'offline';

const STATUS_PROBE_TIMEOUT_MS = 8000;
const STATUS_PROBE_CACHE_MS = 5000;
const PROBE_FAILURES_BEFORE_OFFLINE = 2;
const listeners = new Set<(status: NetworkStatus) => void>();
let currentStatus: NetworkStatus = getInitialNetworkStatus();
let pendingProbe: Promise<boolean> | null = null;
let lastProbeAt = 0;
let lastProbeResult = currentStatus === 'online';
let consecutiveProbeFailures = 0;

export function browserReportsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function getInitialNetworkStatus(): NetworkStatus {
  return browserReportsOffline() ? 'offline' : 'online';
}

export function getCurrentNetworkStatus(): NetworkStatus {
  return currentStatus;
}

export function setCurrentNetworkStatus(status: NetworkStatus): void {
  if (currentStatus === status) return;
  currentStatus = status;
  for (const listener of Array.from(listeners)) {
    listener(status);
  }
}

export function subscribeNetworkStatus(listener: (status: NetworkStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordNodeWardenReachable(): void {
  consecutiveProbeFailures = 0;
  lastProbeResult = true;
  setCurrentNetworkStatus('online');
}

/**
 * 「拿不到后端」的统一判定：浏览器自报离线、探针已翻离线，或**根本没有访问令牌**。
 * ⚠️ 无令牌本身就是离线信号（会话持久化刻意不存令牌）；只看 `navigator.onLine` 会漏掉
 * 「有令牌但网络断了」——那时写请求会真的发出去、重试三次后弹一句英文原文。
 */
export function backendUnreachable(options: { hasAccessToken: boolean }): boolean {
  return browserReportsOffline() || getCurrentNetworkStatus() === 'offline' || !options.hasAccessToken;
}

export function recordNodeWardenUnreachable(): void {
  lastProbeResult = false;
  consecutiveProbeFailures += 1;
  if (browserReportsOffline() || consecutiveProbeFailures >= PROBE_FAILURES_BEFORE_OFFLINE) {
    setCurrentNetworkStatus('offline');
  }
}

export async function probeNodeWardenService(): Promise<boolean> {
  if (browserReportsOffline()) {
    consecutiveProbeFailures = PROBE_FAILURES_BEFORE_OFFLINE;
    setCurrentNetworkStatus('offline');
    return false;
  }

  const now = Date.now();
  if (pendingProbe) return pendingProbe;
  if (now - lastProbeAt < STATUS_PROBE_CACHE_MS) return lastProbeResult;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? window.setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS)
    : 0;

  pendingProbe = (async () => {
    await fetch(`/api/web-bootstrap?statusProbe=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      signal: controller?.signal,
    });
    // Any same-origin HTTP response proves the server is reachable. A 4xx/5xx
    // response may be an application problem, but it is not offline mode.
    return true;
  })()
    .catch(() => false)
    .then((result) => {
      lastProbeAt = Date.now();
      if (result) {
        recordNodeWardenReachable();
      } else {
        recordNodeWardenUnreachable();
      }
      return result;
    })
    .finally(() => {
      if (timer) window.clearTimeout(timer);
      pendingProbe = null;
    });

  return pendingProbe;
}

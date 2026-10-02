import { Wifi, WifiOff } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '@/lib/i18n';
import {
  browserReportsOffline,
  getCurrentNetworkStatus,
  probeNodeWardenService,
  setCurrentNetworkStatus,
  subscribeNetworkStatus,
  type NetworkStatus,
} from '@/lib/network-status';

/**
 * 周期兜底的间隔。每次探针都是**一次完整 Worker 调用**（`cache: 'no-store'` + 唯一 query），
 * 原为 30 秒 ⇒ 页面开着就是 120 次/小时。首屏、`online`、重新聚焦、重新可见各已探一次，
 * 且真实 API 失败也会翻状态（`api/auth.ts` 的 `recordNodeWardenUnreachable`）⇒ 周期只做兜底。
 */
const STATUS_CHECK_INTERVAL_MS = 5 * 60_000;

function statusLabel(status: NetworkStatus): string {
  if (status === 'online') return t('txt_online');
  return t('txt_offline');
}

export default function NetworkStatusBadge() {
  const [status, setStatus] = useState<NetworkStatus>(getCurrentNetworkStatus);
  const label = statusLabel(status);
  const Icon = status === 'online' ? Wifi : WifiOff;

  useEffect(() => {
    let timer = 0;

    const checkService = async () => {
      if (browserReportsOffline()) {
        setCurrentNetworkStatus('offline');
        return;
      }
      await probeNodeWardenService();
    };

    const scheduleNextCheck = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // 后台标签不探（会被节流到约 1 次/分钟，白烧调用）；重新可见时由下面的 visibilitychange 补一次。
        const pending = document.visibilityState === 'visible' ? checkService() : Promise.resolve();
        void pending.finally(scheduleNextCheck);
      }, STATUS_CHECK_INTERVAL_MS);
    };

    const handleOnline = () => {
      void checkService();
    };
    const handleOffline = () => {
      setCurrentNetworkStatus('offline');
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkService();
    };

    const unsubscribe = subscribeNetworkStatus(setStatus);
    void checkService().finally(scheduleNextCheck);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return (
    <span
      className={`network-status-badge ${status}`}
      title={label}
      aria-label={label}
      aria-live="polite"
    >
      <Icon size={14} aria-hidden="true" />
      <span className="network-status-label">{label}</span>
    </span>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { getCurrentNetworkStatus, subscribeNetworkStatus, type NetworkStatus } from '@/lib/network-status';

/**
 * 订阅全局在线状态。
 *
 * 只在事件回调里读一次的场景用 `getCurrentNetworkStatus()` 就够；组件要**随状态变化重渲染**
 * 时（例如离线时把「没有待批准请求」换成「连不上后端」）才需要这个 hook。
 */
export default function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(getCurrentNetworkStatus);
  useEffect(() => subscribeNetworkStatus(setStatus), []);
  return status;
}

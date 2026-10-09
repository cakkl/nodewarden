/**
 * 机密管理器的实时事件总线：`App.tsx` 是唯一持有 socket 的地方，刷新由具体页面执行 ——
 * 用一张极小的订阅表把两边接起来，免得把页面引用塞进 `App`。
 */
export type SecretsManagerRealtimeKind = 'secrets' | 'machine-accounts';

/** 服务端读取的请求头：机密管理器的「标签页」上下文。 */
export const SECRETS_MANAGER_CONTEXT_HEADER = 'X-NodeWarden-Sm-Context-Id';

let tabFallbackSeq = 0;

/**
 * 本**标签页**的随机标识（每次加载一个新值；刷新后本来也没什么需要抑制的）。
 * ⚠️ 不能复用设备标识：同设备两个标签页值相同 ⇒ 会互相抑制掉刷新，而那正是本功能主要用途。
 * ⚠️ 兜底不得用 `Math.random`：它会进请求头，代码扫描会判成弱随机（改法与 `export-formats.ts` 同）。
 */
const SECRETS_MANAGER_TAB_ID = (() => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `tab-${Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
  }
  // 远古浏览器连 `getRandomValues` 都没有：它只是回声抑制用的代号，不是凭据，可预测也无害。
  tabFallbackSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabFallbackSeq}`;
})();

export function getSecretsManagerTabId(): string {
  return SECRETS_MANAGER_TAB_ID;
}

type Listener = (kind: SecretsManagerRealtimeKind) => void;

const listeners = new Set<Listener>();

/** 订阅；返回退订函数，可直接作为 `useEffect` 的清理。 */
export function onSecretsManagerChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitSecretsManagerChange(kind: SecretsManagerRealtimeKind): void {
  for (const listener of [...listeners]) listener(kind);
}

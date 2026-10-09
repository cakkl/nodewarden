/**
 * 机密管理器的实时事件总线：`App.tsx` 是唯一持有 socket 的地方，刷新由具体页面执行 ——
 * 用一张极小的订阅表把两边接起来，免得把页面引用塞进 `App`。
 */
export type SecretsManagerRealtimeKind = 'secrets' | 'machine-accounts';

/** 服务端读取的请求头：机密管理器的「标签页」上下文。 */
export const SECRETS_MANAGER_CONTEXT_HEADER = 'X-NodeWarden-Sm-Context-Id';

/**
 * 本**标签页**的随机标识（每次加载一个新值；刷新后本来也没什么需要抑制的）。
 *
 * ⚠️ 不能复用设备标识（`localStorage` 里那个）：同设备两个标签页拿到的值相同 ⇒ A 的改动会把
 * B 的刷新一起抑制掉，而「另一个标签页跟着更新」正是本功能主要用途。
 */
const SECRETS_MANAGER_TAB_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
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

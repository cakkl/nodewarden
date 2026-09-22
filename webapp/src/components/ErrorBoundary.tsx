/**
 * 内容区错误边界：页面组件抛错时不会连带卸载整棵内容树（否则只剩导航栏）。
 *
 * 另外识别「chunk 加载失败」—— 部署新版本后旧页面向已被删除的资源发请求 —— 这类故障刷新一次即可
 * 自愈，所以自动重载，不必让用户手动操作。
 */
import { Component, type ComponentChildren } from 'preact';
import { t } from '@/lib/i18n';

/** 上次自动重载的时间戳。放在 sessionStorage 里，刷新后仍然保留。 */
const RELOAD_AT_KEY = 'nodewarden:chunk-reload-at';
/** 两次自动重载之间的最小间隔：服务器真挂了时不能变成刷新死循环。 */
const RELOAD_MIN_INTERVAL_MS = 10_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

/** 判断是否属于「动态导入拿不到资源」这一类可自愈的故障。 */
export function isChunkLoadError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message) ||
    /chunkloaderror/i.test(message)
  );
}

interface ErrorBoundaryProps {
  children: ComponentChildren;
}

interface ErrorBoundaryState {
  error: unknown;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    if (!isChunkLoadError(error)) return;
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(window.sessionStorage.getItem(RELOAD_AT_KEY) || 0) || 0;
    } catch {
      // sessionStorage 不可用（隐私模式等）⇒ 不自动重载，交给用户点重试
      return;
    }
    if (Date.now() - lastReloadAt < RELOAD_MIN_INTERVAL_MS) return;
    try {
      window.sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  }

  render() {
    if (this.state.error === null) {
      return this.props.children as never;
    }

    const chunkFailure = isChunkLoadError(this.state.error);
    return (
      <div className="stack">
        <div className="settings-submodule">
          <h3>{t('txt_error_boundary_title')}</h3>
          <p className="field-help">
            {chunkFailure ? t('txt_error_boundary_chunk_help') : t('txt_error_boundary_help')}
          </p>
          <pre style={{ margin: '0 0 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', opacity: 0.7 }}>
            {errorMessage(this.state.error)}
          </pre>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t('txt_refresh')}
          </button>
        </div>
      </div>
    );
  }
}

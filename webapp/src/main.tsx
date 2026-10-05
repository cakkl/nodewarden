import { render } from 'preact';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initI18n } from './lib/i18n';
import { registerNodeWardenServiceWorker } from './lib/pwa';
import { legacyPublicSendPath } from './lib/routes';
import './tailwind.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const root = document.getElementById('root')!;
root.setAttribute('translate', 'no');

function renderApp(): void {
  // 必须先清空 `#root`：Preact 的 `render()` 不会移除容器里已有的 DOM（与 React 不同），
  // 否则 `index.html` 里的启动骨架会留下、与应用页面拼成两屏。
  root.replaceChildren();
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
    root
  );
}

void initI18n().finally(() => {
  // 渲染前先把旧 hash 分享链接换成路径形态，否则它会落到登录页。
  const legacyPath = legacyPublicSendPath(window.location.hash);
  if (legacyPath) window.history.replaceState(null, '', legacyPath);
  renderApp();
  registerNodeWardenServiceWorker();
});

import { render } from 'preact';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initI18n } from './lib/i18n';
import { registerNodeWardenServiceWorker } from './lib/pwa';
import './tailwind.css';
import './styles.css';

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
  renderApp();
  registerNodeWardenServiceWorker();
});

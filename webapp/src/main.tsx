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
  // 必须先清空 `#root`：Preact 的 `render()` 与 React 不同，**不会移除**容器里已有的 DOM。
  // `index.html` 里的启动骨架（`.boot-screen`）于是会一直留下，和应用页面上下拼成两屏
  // —— 表现是「多出一屏、页面能滚到骨架屏」，与路由无关、所有页面都受影响。
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

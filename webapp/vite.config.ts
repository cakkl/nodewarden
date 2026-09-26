import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

function buildServiceWorkerSource(precacheUrls: string[], version: string): string {
  return `const CACHE_VERSION = ${JSON.stringify(`nodewarden-pwa-${version}`)};
const APP_SHELL_CACHE = \`\${CACHE_VERSION}-shell\`;
const RUNTIME_CACHE = 'nodewarden-pwa-runtime-v1';

const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};
const CRITICAL_SHELL_URLS = ['/', '/index.html'];
const STATIC_PATH_RE = /^\\/(?:assets\\/|payment-logos\\/|icon-|logo-|favicon|apple-touch-icon|nodewarden-|manifest\\.webmanifest$)/;
const NEVER_CACHE_PATH_RE = /^\\/(?:api|identity|setup|config|notifications|icons|\\.well-known|cdn-cgi)(?:\\/|$)/;
const OFFLINE_FALLBACK_HTML = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>NodeWarden</title><style>html,body{height:100%;margin:0;background:#eef4ff;color:#0f172a;font-family:ui-sans-serif,system-ui,sans-serif}.boot-screen{min-height:100%;display:grid;place-items:center;padding:24px;box-sizing:border-box}.boot-card{width:min(420px,100%);display:grid;gap:12px;justify-items:center;padding:28px;border:1px solid rgba(148,163,184,.35);border-radius:22px;background:rgba(255,255,255,.86);box-shadow:0 20px 45px rgba(15,23,42,.1)}.boot-logo{width:74px;height:58px;object-fit:contain}.boot-title{font-weight:700}.boot-sub{color:#475569;text-align:center;font-size:14px;line-height:1.5}</style></head><body><div class="boot-screen"><div class="boot-card"><img class="boot-logo" src="/nodewarden-logo.svg" alt=""><div class="boot-title">NodeWarden</div><div class="boot-sub">Offline cache is not ready on this device. Open NodeWarden once while online, then try offline again.</div></div></div></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(async (cache) => {
        await cache.addAll(CRITICAL_SHELL_URLS);
        const nonCriticalUrls = PRECACHE_URLS.filter((url) => !CRITICAL_SHELL_URLS.includes(url));
        await Promise.allSettled(nonCriticalUrls.map((url) => cache.add(url)));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('nodewarden-pwa-') && key.endsWith('-shell') && key !== APP_SHELL_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isSameOriginHttpGet(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin;
}

function isCacheableResponse(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

async function warmStaticDependencies(response) {
  try {
    const html = await response.text();
    const runtimeCache = await caches.open(RUNTIME_CACHE);
    const urls = Array.from(html.matchAll(/\\b(?:src|href)=["']([^"']+)["']/g))
      .map((match) => {
        try {
          return new URL(match[1], self.location.origin);
        } catch {
          return null;
        }
      })
      .filter((url) => url && url.origin === self.location.origin && STATIC_PATH_RE.test(url.pathname))
      .map((url) => url.pathname + url.search);
    await Promise.allSettled(Array.from(new Set(urls)).map((url) => runtimeCache.add(url)));
    await trimRuntimeCache(runtimeCache, 120);
  } catch {
    // Dependency warming is best-effort; never slow or break navigation for it.
  }
}

async function appShellNavigation(request) {
  const cache = await caches.open(APP_SHELL_CACHE);
  const url = new URL(request.url);

  // 必须 network-first：缓存的 index.html 记着的是一整套旧 chunk 名，部署后那些文件
  // 全部不存在，用它渲染会白屏。离线时才回退到缓存。
  if (navigator.onLine !== false) {
    try {
      const response = await fetch(request);
      if (isCacheableResponse(response)) {
        const shellCopy = response.clone();
        await cache.put('/index.html', response.clone());
        await cache.put('/', response.clone());
        // 依赖预热是 best-effort，不能阻塞导航
        void warmStaticDependencies(shellCopy);
        return response;
      }
    } catch {
      // 落到下面的缓存分支
    }
  }

  return (
    (await cache.match(request, { ignoreSearch: true }))
    || (await cache.match(url.pathname, { ignoreSearch: true }))
    || (await cache.match('/'))
    || (await cache.match('/index.html'))
    || new Response(OFFLINE_FALLBACK_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    })
  );
}

async function connectorNavigation(request) {
  const runtimeCache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheableResponse(response)) {
      await runtimeCache.put(request, response.clone());
      await trimRuntimeCache(runtimeCache, 120);
    }
    return response;
  } catch {
    const shellCache = await caches.open(APP_SHELL_CACHE);
    const cached =
      (await shellCache.match(request, { ignoreSearch: true }))
      || (await runtimeCache.match(request, { ignoreSearch: true }))
      || (await matchLegacyRuntimeCache(request));
    return cached || new Response('WebAuthn connector is unavailable while offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }
}

async function trimRuntimeCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function cacheFirst(request) {
  const shellCache = await caches.open(APP_SHELL_CACHE);
  const cachedShell = await shellCache.match(request);
  if (cachedShell) return cachedShell;

  const runtimeCache = await caches.open(RUNTIME_CACHE);
  const cachedRuntime = await runtimeCache.match(request);
  if (cachedRuntime) return cachedRuntime;

  const legacyRuntime = await matchLegacyRuntimeCache(request);
  if (legacyRuntime) return legacyRuntime;

  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    void runtimeCache.put(request, response.clone()).then(() => trimRuntimeCache(runtimeCache, 120));
  }
  return response;
}

async function matchLegacyRuntimeCache(request) {
  const keys = await caches.keys();
  for (const key of keys) {
    if (key === RUNTIME_CACHE || !key.startsWith('nodewarden-pwa-') || !key.endsWith('-runtime')) continue;
    const cache = await caches.open(key);
    const cached = await cache.match(request);
    if (cached) return cached;
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isSameOriginHttpGet(request)) return;

  const url = new URL(request.url);
  if (NEVER_CACHE_PATH_RE.test(url.pathname)) return;

  // Connector navigations are protocol pages, not application routes. They must
  // never be replaced with the SPA shell, even when the device is offline.
  if (url.pathname.endsWith('-connector.html')) {
    event.respondWith(connectorNavigation(request));
    return;
  }

  if (request.mode === 'navigate') {
    // 缓存写入已包含在 appShellNavigation 内部，不再额外发一次请求
    event.respondWith(appShellNavigation(request));
    return;
  }

  if (STATIC_PATH_RE.test(url.pathname) || request.destination === 'script' || request.destination === 'style' || request.destination === 'font' || request.destination === 'image' || request.destination === 'worker') {
    event.respondWith(cacheFirst(request));
  }
});
`;
}

function buildCacheVersion(isDemo: boolean, urls: string[]): string {
  const digest = createHash('sha256')
    .update(`${isDemo ? 'demo' : 'app'}\n${urls.join('\n')}`)
    .digest('hex')
    .slice(0, 16);
  return `${isDemo ? 'demo' : 'app'}-${digest}`;
}

function pwaServiceWorkerPlugin(isDemo: boolean): Plugin {
  return {
    name: 'nodewarden-pwa-service-worker',
    generateBundle(_, bundle) {
      const urls = new Set<string>([
        '/',
        '/index.html',
        '/vault',
        '/manifest.webmanifest',
        '/nodewarden-logo.svg',
        '/nodewarden-logo-bg.svg',
        '/nodewarden-wordmark.svg',
        '/favicon.ico',
        '/favicon-32.png',
        '/apple-touch-icon.png',
        '/icon-192.png',
        '/icon-512.png',
        '/logo-64.png',
      ]);
      const buildUrls = new Set<string>(urls);

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk' && output.type !== 'asset') continue;
        if (fileName === 'sw.js' || fileName === 'robots.txt') continue;
        if (fileName.endsWith('.map')) continue;
        buildUrls.add(`/${fileName}`);
      }

      const sortedUrls = Array.from(buildUrls).sort();
      const version = buildCacheVersion(isDemo, Array.from(buildUrls).sort());
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: buildServiceWorkerSource(sortedUrls, version),
      });
    },
  };
}

/**
 * demo 模式没有 wrangler 后端（8787），但前端仍会发探活请求（`/api/web-bootstrap?statusProbe=…`）。
 * 既不挂代理、SPA fallback 又不覆盖 `Accept: application/json` 的请求，于是浏览器控制台会刷 404 ——
 * 纯噪音，却极易被误读成业务代码出错（这就是本插件存在的理由）。
 *
 * 这里给 demo 装一个最小应答器：`/api/**` 一律返回 200 + 空 JSON。探针只要拿到任何同源响应就判定
 * “服务可达”，语义也是对的：demo 的“服务端”本来就是前端自己。
 */
function demoApiStubPlugin(): Plugin {
  return {
    name: 'nodewarden:demo-api-stub',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (!req.url || !req.url.startsWith('/api/')) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end('{}');
      });
    },
  };
}

function searchIndexPolicyPlugin(isDemo: boolean): Plugin {
  return {
    name: 'nodewarden-search-index-policy',
    transformIndexHtml(html: string) {
      if (isDemo) return html;
      return html.replace(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />'
      );
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: isDemo
          ? 'User-agent: *\nAllow: /\n'
          : 'User-agent: *\nDisallow: /\n',
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    root: rootDir,
    plugins: [
      // prefresh 关掉：@prefresh/babel-plugin 0.5.3 在 Vite 8 上会无限递归
      //（`getFirstParent` 爆栈，dev server 每个文件都报 Maximum call stack size exceeded）。
      // 它只影响开发时的组件热替换（退化为整页刷新），构建与运行时不参与。
      // 上游修好后（preset-vite 的 peer 已声明支持 Vite 8，但内部 prefresh 还没跟上）删掉这个选项。
      preact({ prefreshEnabled: false }),
      searchIndexPolicyPlugin(isDemo),
      pwaServiceWorkerPlugin(isDemo),
      // demo 没有后端，但仍会被探针请求 /api/** ⇒ 给一个最小应答，避免控制台噪音
      ...(isDemo ? [demoApiStubPlugin()] : []),
    ],
    define: {
      __NODEWARDEN_DEMO__: JSON.stringify(isDemo),
    },
    resolve: {
      alias: {
        '@/lib/demo': path.resolve(rootDir, isDemo ? 'src/lib/demo.ts' : 'src/lib/demo.empty.ts'),
        '@/lib/demo-brand-icons': path.resolve(
          rootDir,
          isDemo ? 'src/lib/demo-brand-icons.ts' : 'src/lib/demo.empty.ts'
        ),
        '@': path.resolve(rootDir, 'src'),
        '@shared': path.resolve(rootDir, '../shared'),
      },
    },
    build: {
      outDir: path.resolve(rootDir, '../dist'),
      emptyOutDir: true,
      sourcemap: false,
      target: 'esnext',
      chunkSizeWarningLimit: 800,
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'shared',
                minShareCount: 2,
                minSize: 50 * 1024,
                priority: 10,
              },
              {
                name(id) {
                  const normalized = id.replace(/\\/g, '/');
                  const localeMatch = normalized.match(/\/src\/lib\/i18n\/locales\/(.+)\.ts$/);
                  return localeMatch && localeMatch[1] !== 'en' ? `i18n-${localeMatch[1]}` : null;
                },
                test: /[\\/]src[\\/]lib[\\/]i18n[\\/]locales[\\/]/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
    server: {
      port: 5173,
      fs: {
        allow: [path.resolve(rootDir, '..')],
      },
      // demo 模式只跑前端（5174），并没有 wrangler 后端（8787）。
      // 以前这里固定挂代理，于是网络状态探针 `/api/web-bootstrap` 会持续 ECONNREFUSED，
      // vite 每次失败都打印 `http proxy error` —— 纯噪音，却极易被误读成业务代码出错。
      // 不挂代理时请求落到 vite 自身、被 SPA fallback 成 200，探针据此判定“服务可达”，
      // 语义也是对的：demo 的“服务端”就是前端自己。
      ...(isDemo
        ? {}
        : {
            proxy: {
              '/api': 'http://127.0.0.1:8787',
              '/identity': 'http://127.0.0.1:8787',
              '/setup': 'http://127.0.0.1:8787',
              '/icons': 'http://127.0.0.1:8787',
              '/config': 'http://127.0.0.1:8787',
              '/notifications': 'http://127.0.0.1:8787',
              '/.well-known': 'http://127.0.0.1:8787',
            },
          }),
    },
  };
});

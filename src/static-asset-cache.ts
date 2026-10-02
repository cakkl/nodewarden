/**
 * 静态资源缓存策略（由 `src/index.ts` 的 `maybeServeAsset()` 调用）。
 *
 * `_headers` 不作用于 Worker 生成的响应（`run_worker_first` 下官方文档点名），只能在这里下发：
 * - `/assets/*` 带内容指纹 ⇒ 永久 + `immutable`；
 * - 根目录图标 / `manifest.webmanifest` / `payment-logos/*` 名字无指纹 ⇒ 只给 1 天，且**不加**
 *   `immutable`（否则换图标后连手动刷新都换不到）；
 * - `index.html`、`sw.js`、`webauthn-*` 等**不在**名单里，保持默认 `must-revalidate` ——
 *   它们关系「部署后能否拿到新版」与「SW 能否更新」。
 */

/** 带内容指纹的产物：一年 + `immutable`。 */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** 名字不含指纹、但极少变动的静态文件：1 天。 */
export const SHORT_STATIC_CACHE_CONTROL = 'public, max-age=86400';

const SHORT_CACHE_STATIC_PATHS = new Set([
  '/favicon.ico',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/logo-64.png',
  '/icon-source.svg',
  '/nodewarden-logo.svg',
  '/nodewarden-logo-bg.svg',
  '/nodewarden-wordmark.svg',
  '/manifest.webmanifest',
]);

/** 返回该路径应设的 `Cache-Control`；`null` = 保持静态资源的默认值。 */
export function staticCacheControl(pathname: string): string | null {
  if (pathname.startsWith('/assets/')) return IMMUTABLE_ASSET_CACHE_CONTROL;
  if (pathname.startsWith('/payment-logos/')) return SHORT_STATIC_CACHE_CONTROL;
  if (SHORT_CACHE_STATIC_PATHS.has(pathname)) return SHORT_STATIC_CACHE_CONTROL;
  return null;
}

/** 只改 200 响应的头（304/404 等保持原样，避免把错误响应的缓存语义改掉）。 */
export function withStaticCacheHeaders(pathname: string, response: Response): Response {
  const cacheControl = staticCacheControl(pathname);
  if (!cacheControl || response.status !== 200) return response;

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

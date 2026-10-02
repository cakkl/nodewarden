// 静态资源缓存与 Service Worker 的护栏（2026-09-30「少往返 / 离线」一轮）。
//
// 这些约束破了都不报错，只在用户侧静默劣化：「每次导航都重新校验」「离线切语言失败」、
// 「兜底页英文 + 破图」。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  SHORT_STATIC_CACHE_CONTROL,
  staticCacheControl,
  withStaticCacheHeaders,
} from '../../src/static-asset-cache';
import { AVAILABLE_LOCALES } from '../../webapp/src/lib/i18n';
import { OFFLINE_FALLBACK_MESSAGES } from '../../webapp/src/lib/offline-fallback-messages';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

// ---------------------------------------------------------------- 缓存头

test('带内容指纹的产物（/assets/*）必须永久缓存 + immutable', () => {
  assert.equal(staticCacheControl('/assets/index-CBvTFpSJ.js'), IMMUTABLE_ASSET_CACHE_CONTROL);
  assert.match(IMMUTABLE_ASSET_CACHE_CONTROL, /max-age=31536000/);
  assert.match(IMMUTABLE_ASSET_CACHE_CONTROL, /immutable/);
});

test('根目录无指纹的图标 / manifest 拿 1 天缓存，且不能带 immutable', () => {
  for (const pathname of [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/manifest.webmanifest',
    '/nodewarden-logo.svg',
    '/icon-512.png',
  ]) {
    assert.equal(staticCacheControl(pathname), SHORT_STATIC_CACHE_CONTROL, `${pathname} 应拿到 1 天缓存`);
  }
  assert.equal(staticCacheControl('/payment-logos/cards/visa.svg'), SHORT_STATIC_CACHE_CONTROL);
  assert.match(SHORT_STATIC_CACHE_CONTROL, /max-age=86400/);
  // 带 immutable 的话，用户手动刷新也换不到新图标 —— 无指纹的文件不能这样。
  assert.doesNotMatch(SHORT_STATIC_CACHE_CONTROL, /immutable/);
});

test('关系「部署后能否拿到新版」的路径必须保持默认缓存语义', () => {
  for (const pathname of ['/', '/index.html', '/sw.js', '/404.html', '/webauthn-connector.js', '/robots.txt', '/api/config']) {
    assert.equal(staticCacheControl(pathname), null, `${pathname} 不应被加缓存头`);
  }
});

test('只覆盖 200 响应：错误响应原样返回', () => {
  const notFound = new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(withStaticCacheHeaders('/assets/whatever.js', notFound), notFound, '404 不该被改写（会把错误响应的语义也改掉）');

  const ok = new Response('x', { status: 200, headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' } });
  assert.equal(withStaticCacheHeaders('/assets/whatever.js', ok).headers.get('Cache-Control'), IMMUTABLE_ASSET_CACHE_CONTROL);
});

// ---------------------------------------------------------------- Service Worker

test('语言包不进 SW 预缓存（英文除外）：首访后台不再白下 ~900 KB', () => {
  const config = readSource('webapp/vite.config.ts');
  assert.ok(
    config.includes(String.raw`/^assets\/i18n-(?!en-)[^/]+\.js$/`),
    '预缓存清单必须显式跳过**非英文**语言包（9 个 ≈ 900 KB）'
  );
  assert.ok(
    !config.includes(String.raw`/^assets\/i18n-[^/]+\.js$/`),
    '不能连英文一起跳过：en 是加载失败时的兜底表，必须离线可用'
  );
});

test('不再每次导航重抓一轮 HTML 引用的静态资源', () => {
  const config = readSource('webapp/vite.config.ts');
  assert.ok(
    !config.includes('warmStaticDependencies'),
    '每次导航的重复预热已移除（它是导航时 8–13 个 304 的唯一来源；预缓存已经覆盖这些 URL）'
  );
});

test('离线兜底页：不引外部资源（logo 内联）、文案按 Accept-Language 选', () => {
  const config = readSource('webapp/vite.config.ts');
  assert.ok(!config.includes('<img class="boot-logo"'), '兜底页出现时缓存是空的，任何网络图片都必然破图');
  assert.ok(config.includes('__LOGO__'), 'logo 应在构建期内联进模板');
  assert.ok(config.includes('readOfflineFallbackLogo'), 'logo 来自 webapp/public/nodewarden-logo.svg');
  assert.ok(config.includes('__MESSAGE__'), '文案应在运行时按语言替换');
  assert.ok(config.includes('Accept-Language'), '语言只能从导航请求头里取（此时没有任何语言包可用）');
});

test('兜底页文案：每个受支持语言都必须有非空翻译', () => {
  for (const { value } of AVAILABLE_LOCALES) {
    const message = OFFLINE_FALLBACK_MESSAGES[value];
    assert.ok(
      typeof message === 'string' && message.trim().length > 0,
      `${value} 缺少兜底文案：加语言时 webapp/src/lib/offline-fallback-messages.ts 要一起加`
    );
  }
  assert.equal(
    Object.keys(OFFLINE_FALLBACK_MESSAGES).length,
    AVAILABLE_LOCALES.length,
    '文案表与 AVAILABLE_LOCALES 必须一一对应（多出来的键说明有语言被删了）'
  );
});

// ---------------------------------------------------------------- 语言包延后预取

test('语言包预取只在登录就绪后触发', () => {
  const app = readSource('webapp/src/App.tsx');
  const callIndex = app.indexOf('scheduleOfflineLocalePrefetch();');
  assert.ok(callIndex > 0, 'App.tsx 里应当调用 scheduleOfflineLocalePrefetch()');

  // 取「包含这次调用的那个 effect」：不能用固定长度的前后窗口 —— 那样会误取到相邻 effect 的门控，
  // 门控删掉也照样绿（本护栏第一版就是这么漏过去的，证伪时才被发现）。
  const effectStart = app.lastIndexOf('useEffect(', callIndex);
  const effectEnd = app.indexOf(']);', callIndex);
  assert.ok(effectStart >= 0 && effectEnd > callIndex, '取不到包含该调用的 effect 块（改名了请同步本护栏）');
  const effect = app.slice(effectStart, effectEnd);
  assert.ok(effect.length < 600, '取到的 effect 块过大，可能跨到了别的 effect（本护栏要跟着改）');
  assert.match(effect, /phase !== 'app'/, '必须等应用就绪（登录成功 + 解密完成）再预取，别让只是路过登录页的人也花流量');
  assert.match(effect, /!vaultInitialDecryptDone/);
});

test('语言包预取尊重省流量 / 慢网，并走空闲调度', () => {
  const pwa = readSource('webapp/src/lib/pwa.ts');
  assert.match(pwa, /saveData/, '开了省流量模式就不该预取');
  assert.match(pwa, /slow-2g/, '极慢网络不预取');
  assert.match(pwa, /requestIdleCallback/, '别和首屏、接口请求抢带宽');
  // 3g 不排除：跨境访问时估算常常就是 3g，拿它当门槛会让预取永远不跑（静默失效）。
  assert.doesNotMatch(pwa, /\[\s*'slow-2g',\s*'2g',\s*'3g'/, '不要把 3g 列为排除项');
});

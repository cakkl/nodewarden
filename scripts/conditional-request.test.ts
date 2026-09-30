// 条件请求（ETag / 304）的护栏。
//
// 这几条破了都不报错，只在用户侧静默多下载：304 变成每次全量重传、缓存头写成 `no-store`
// 让条件请求**永不发生**（等于白做）、或 304 忘了带 ETag（客户端会丢掉已缓存的那份）。
//
// 运行方式：npm run test:conditional-request
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfigResponse, configEtag } from '../src/config-response';
import { handleGetDomains } from '../src/handlers/domains';
import { handlePublicRoute } from '../src/router-public';
import type { Env } from '../src/types';
import { matchesIfNoneMatch } from '../src/utils/conditional-request';
import { createSchemaDatabase, insertUser } from './lib/test-harness';

const URL = 'https://vault.example.test/api/settings/domains';

function buildEnv(db: Env['DB']): Env {
  return { DB: db } as unknown as Env;
}

const withETag = (etag: string) => new Request(URL, { headers: { 'If-None-Match': etag } });

test('If-None-Match 用弱比较：忽略 W/ 前缀，支持逗号列表与 *', () => {
  const etag = 'W/"domains-2026-01-01-abc123"';
  assert.equal(matchesIfNoneMatch(new Request(URL), etag), false, '没有 If-None-Match 就不算命中');
  assert.equal(matchesIfNoneMatch(withETag(etag), etag), true);
  assert.equal(matchesIfNoneMatch(withETag('"domains-2026-01-01-abc123"'), etag), true, '客户端去掉 W/ 前缀也应命中');
  assert.equal(matchesIfNoneMatch(withETag('"other", W/"domains-2026-01-01-abc123"'), etag), true, '列表里任一命中即可');
  assert.equal(matchesIfNoneMatch(withETag('*'), etag), true);
  assert.equal(matchesIfNoneMatch(withETag('W/"domains-other-version"'), etag), false);
});

test('GET /api/settings/domains：内容没变回 304，改了设置就必须重传', async () => {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, 'user-1');
  handle.connection
    .prepare(
      'INSERT INTO domain_settings (user_id, equivalent_domains, custom_equivalent_domains, excluded_global_equivalent_domains, updated_at) VALUES (?,?,?,?,?)'
    )
    .run('user-1', '[]', '[]', '[]', '2026-01-01T00:00:00.000Z');
  const env = buildEnv(handle.db);

  const first = await handleGetDomains(new Request(URL), env, 'user-1');
  assert.equal(first.status, 200);
  const etag = first.headers.get('ETag');
  assert.ok(etag, '只读 GET 必须给 ETag，否则浏览器无从校验');
  const cacheControl = first.headers.get('Cache-Control') || '';
  assert.match(cacheControl, /no-cache/, '必须让浏览器「存下来但每次校验」');
  assert.doesNotMatch(cacheControl, /no-store/, 'no-store 会让条件请求永不发生 —— 加了 ETag 也白做');
  const body = await first.text();
  assert.ok(body.length > 5000, `响应应含全局等价域名表（实测 ≈10 KB），实际 ${body.length} B`);

  const second = await handleGetDomains(withETag(etag), env, 'user-1');
  assert.equal(second.status, 304, '内容未变应回 304');
  assert.equal(await second.text(), '', '304 不能带 body');
  assert.equal(second.headers.get('ETag'), etag, '304 必须带回同样的 ETag，否则客户端会丢掉缓存');
  assert.equal(second.headers.get('Cache-Control'), cacheControl);

  handle.connection
    .prepare('UPDATE domain_settings SET updated_at = ? WHERE user_id = ?')
    .run('2026-02-02T00:00:00.000Z', 'user-1');
  const third = await handleGetDomains(withETag(etag), env, 'user-1');
  assert.equal(third.status, 200, '用户设置变了还回 304 就是数据陈旧');
  assert.notEqual(third.headers.get('ETag'), etag, 'ETag 必须随 domain_settings.updated_at 变');

  handle.close();
});

test('没有 domain_settings 行的用户也能走条件请求', async () => {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, 'fresh-user');
  const env = buildEnv(handle.db);

  const first = await handleGetDomains(new Request(URL), env, 'fresh-user');
  assert.equal(first.status, 200);
  const etag = first.headers.get('ETag');
  assert.ok(etag, '新用户（没有设置行）同样要有 ETag');
  assert.equal((await handleGetDomains(withETag(etag), env, 'fresh-user')).status, 304);

  handle.close();
});

const CONFIG_URL = 'https://vault.example.test/api/config';
const noRateLimit = async () => null;

const getConfig = (env: Env, headers: Record<string, string> = {}) =>
  handlePublicRoute(new Request(CONFIG_URL, { headers }), env, '/api/config', 'GET', noRateLimit);

test('GET /api/config：重复请求回 304，且 ETag 覆盖会变的字段', async () => {
  const handle = await createSchemaDatabase();
  const env = buildEnv(handle.db);

  const first = (await getConfig(env))!;
  assert.equal(first.status, 200);
  const etag = first.headers.get('ETag');
  assert.ok(etag, '公开只读配置同样要有 ETag');
  assert.match(first.headers.get('Cache-Control') || '', /no-cache/, '不能再是 no-store —— 那会让条件请求永不发生');

  const second = (await getConfig(env, { 'If-None-Match': etag }))!;
  assert.equal(second.status, 304);
  assert.equal(await second.text(), '');
  assert.equal(second.headers.get('ETag'), etag);

  // ETag 必须覆盖 body 里所有会变的字段：mail 状态（随管理设置变）与 origin（多域名部署）。
  const body = await buildConfigResponse('https://vault.example.test', env);
  assert.equal(etag, configEtag('https://vault.example.test', body.mailDeliveryAvailable));
  assert.notEqual(configEtag('https://other.example.test', body.mailDeliveryAvailable), etag, 'origin 不同 ⇒ 标必须不同');
  assert.notEqual(configEtag('https://vault.example.test', !body.mailDeliveryAvailable), etag, 'mail 状态变了 ⇒ 标必须变');

  handle.close();
});

test('buildConfigResponse 能复用预先算好的 mail 状态（同一请求不把 D1 查两遍）', async () => {
  const handle = await createSchemaDatabase();
  const env = buildEnv(handle.db);

  assert.equal((await buildConfigResponse('https://vault.example.test', env, true)).mailDeliveryAvailable, true);
  assert.equal((await buildConfigResponse('https://vault.example.test', env, false)).mailDeliveryAvailable, false);

  handle.close();
});

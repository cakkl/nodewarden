// 机密管理器的离线只读缓存（`webapp/src/lib/secrets-offline-cache.ts` + `api/secrets.ts` 的离线部分）。
//
// 这里钉住四件靠肉眼看不出来的事：
// ① ⭐ **只存密文** —— 快照写进 IndexedDB 的字节里不能出现明文（名字 / 值 / 备注）；
// ② ⭐ **签名比对** —— 列表没变就一次请求都不发（全量密文每进一次页面重传是不可接受的）；
// ③ **宁旧勿空** —— 同步失败 / 回空时必须保留旧快照，不能把用户的离线数据清掉；
// ④ **包裹自愈** —— 换了账号或主密码后旧包裹解不开，必须返回 `null` 而不是抛错；
// ⑤ **交回那批密文** —— 写快照的函数要把刚落盘的含值密文返回给调用方（内存索引不必再读一遍）；
// ⑥ **「没读到」≠「读到空」** —— 前者返回 `null`，否则调用方会把还能用的索引清掉、点击全退回网络；
// ⑦ **增量** —— 列表变了也只取比快照最新那条更新的行（起点是服务端时间戳，与本机时钟无关），
//    补不齐就退回全量；写后校准连回收站那次也省掉。
//
// Node 没有 IndexedDB，因此注入内存桩（仓库内首次）：只实现本项目用到的那几个方法。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ensureOfflineSecretsContext,
  ensureSecretsContext,
  getOfflineSecretDetail,
  getOfflineTrashedSecretDetail,
  listSecretTags,
  listSecrets,
  loadOfflineSecretDetails,
  loadOfflineSecrets,
  loadOfflineSecretTags,
  loadOfflineTrash,
  refreshSecretsOfflineSnapshot,
} from '../../webapp/src/lib/api/secrets';
import type { AuthedFetch } from '../../webapp/src/lib/api/shared';
import { bytesToBase64, requireWebCrypto } from '../../webapp/src/lib/crypto';
import { setLocale } from '../../webapp/src/lib/i18n';
import {
  loadSecretsOfflineCache,
  saveCachedSecretsOfflineTrashDetail,
} from '../../webapp/src/lib/secrets-offline-cache';
import { encryptField, splitKeyPair, wrapOrgKey, SYMMETRIC_KEY_BYTES, type SmKeyPair } from '../../webapp/src/lib/secrets-crypto';
import type { SessionState } from '../../webapp/src/lib/types';

await setLocale('en');

const ORG_ID = 'org-1';
const CACHE_KEY = 'user-1';

// ── 内存版 IndexedDB（只够本项目用） ────────────────────────────────────────

interface StubDatabase {
  stores: Map<string, Map<string, unknown>>;
  keyPaths: Map<string, string>;
}

function installIndexedDbStub(): { reset: () => void; restore: () => void } {
  const databases = new Map<string, StubDatabase>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

  /** 请求对象：回调都在微任务里触发，避免实现依赖同步语义。 */
  function makeRequest<T>(produce: () => T): Record<string, unknown> {
    const request: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        request.result = produce();
        (request.onsuccess as (() => void) | null)?.();
      } catch {
        (request.onerror as (() => void) | null)?.();
      }
    });
    return request;
  }

  const stub = {
    open(name: string) {
      const request: Record<string, unknown> = {
        result: undefined,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        let record = databases.get(name);
        if (!record) {
          record = { stores: new Map(), keyPaths: new Map() };
          databases.set(name, record);
        }
        const database = record;
        const connection = {
          objectStoreNames: { contains: (storeName: string) => database.stores.has(storeName) },
          createObjectStore(storeName: string, options?: { keyPath?: string }) {
            database.stores.set(storeName, new Map());
            if (options?.keyPath) database.keyPaths.set(storeName, options.keyPath);
            return {};
          },
          transaction(storeName: string) {
            const store = database.stores.get(storeName);
            const keyPath = database.keyPaths.get(storeName) ?? 'id';
            const transaction: Record<string, unknown> = { onerror: null, onabort: null };
            transaction.objectStore = () => ({
              get: (key: unknown) => makeRequest(() => store?.get(String(key))),
              put: (value: Record<string, unknown>) =>
                makeRequest(() => store?.set(String(value[keyPath]), value)),
              delete: (key: unknown) => makeRequest(() => store?.delete(String(key))),
            });
            return transaction;
          },
        };
        request.result = connection;
        (request.onupgradeneeded as (() => void) | null)?.();
        (request.onsuccess as (() => void) | null)?.();
      });
      return request;
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', { value: stub, configurable: true, writable: true });
  return {
    // 模块级缓存的连接绑在同一个 record 上 ⇒ 清内容而不是丢库，才能隔离每个用例
    reset: () => {
      for (const record of databases.values()) {
        for (const store of record.stores.values()) store.clear();
      }
    },
    restore: () => {
      if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    },
  };
}

const indexedDb = installIndexedDbStub();

// ── 假服务端 ────────────────────────────────────────────────────────────────

interface FakeSecret {
  id: string;
  name: string;
  value: string;
  note: string;
  revisionDate: string;
}

interface FakeTrashedSecret {
  id: string;
  name: string;
  value: string;
  note: string;
  deletedAt: string;
}

interface FakeServer {
  secrets: FakeSecret[];
  trash: FakeTrashedSecret[];
  /** 机密 id → 标签明文（假服务端把它加密后回吐，与真实现一致）。 */
  tags: Record<string, string>;
  /** 同步端点注入的故障（非 `null` 时返回该状态码）。 */
  syncFailure: number | null;
  /** 同步端点强制回空（模拟「版本对不上」）。 */
  syncEmpty: boolean;
  calls: string[];
  authedFetch: AuthedFetch;
}

/**
 * 假服务端。
 *
 * ⚠️ 组织密钥必须**先于**客户端存在：服务端要用它加密夹具，客户端则解开同一把包裹
 * （与 `secrets-api.test.ts` 同一做法），否则两边用的密钥不同，密文根本对不上。
 */
function createServer(orgKey: Uint8Array, wrappedOrgKey: string): FakeServer {
  const keyPair = splitKeyPair(orgKey);
  const encrypted = (plain: string) => encryptField(plain, keyPair);

  const server: FakeServer = {
    secrets: [],
    trash: [],
    tags: {},
    syncFailure: null,
    syncEmpty: false,
    calls: [],
    authedFetch: async (input, init) => {
      const url = String(input);
      server.calls.push(url);

      if (url === '/api/secrets/organization') return jsonResponse({ id: ORG_ID, object: 'organization' });
      if (url === '/api/secrets/organization-key') {
        // 只在首次引导时会上传；夹具已预置包裹 ⇒ 正常路径只会走 GET
        if (init?.method === 'PUT') return jsonResponse({ object: 'organizationKey', wrappedOrgKey });
        return jsonResponse({ object: 'organizationKey', wrappedOrgKey });
      }

      const secretItems = await Promise.all(
        server.secrets.map(async (secret) => ({
          object: 'secret',
          id: secret.id,
          organizationId: ORG_ID,
          key: await encrypted(secret.name),
          creationDate: secret.revisionDate,
          revisionDate: secret.revisionDate,
          projects: [],
        }))
      );

      if (url === `/api/organizations/${ORG_ID}/secrets`) {
        return jsonResponse({ object: 'list', secrets: secretItems, projects: [] });
      }

      if (url === `/api/organizations/${ORG_ID}/secrets/sync` || url.startsWith(`/api/organizations/${ORG_ID}/secrets/sync?`)) {
        if (server.syncFailure !== null) return new Response('boom', { status: server.syncFailure });
        if (server.syncEmpty) return jsonResponse({ hasChanges: false });
        // 官方增量：`lastSyncedDate` 省略 = 回全量；给了就只回 `revision_date` 晚于它的行
        const since = new URL(url, 'http://local').searchParams.get('lastSyncedDate') ?? '';
        const changed = since ? server.secrets.filter((secret) => secret.revisionDate > since) : server.secrets;
        if (since && changed.length === 0) return jsonResponse({ hasChanges: false });
        return jsonResponse({
          hasChanges: true,
          secrets: {
            data: await Promise.all(
              changed.map(async (secret) => ({
                object: 'secret',
                id: secret.id,
                organizationId: ORG_ID,
                key: await encrypted(secret.name),
                value: await encrypted(secret.value),
                note: await encrypted(secret.note),
                creationDate: secret.revisionDate,
                revisionDate: secret.revisionDate,
                projects: [],
              }))
            ),
          },
        });
      }

      if (url === '/api/secrets/tags') {
        // 标签是 Web 扩展字段：假服务端回「id → 标签密文」
        const tags: Record<string, string> = {};
        for (const secret of server.secrets) {
          if (server.tags[secret.id]) tags[secret.id] = (await encrypted(server.tags[secret.id])) as string;
        }
        return jsonResponse({ object: 'secretTags', tags });
      }

      if (url === '/api/secrets/trash') {
        return jsonResponse({
          object: 'trash',
          secrets: await Promise.all(
            server.trash.map(async (row) => ({
              id: row.id,
              key: await encrypted(row.name),
              deletedAt: row.deletedAt,
              projectIds: [],
            }))
          ),
        });
      }

      const trashMatch = url.match(/^\/api\/secrets\/trash\/(.+)$/);
      if (trashMatch) {
        const row = server.trash.find((item) => item.id === decodeURIComponent(trashMatch[1]));
        if (!row) return new Response('not found', { status: 404 });
        return jsonResponse({
          id: row.id,
          key: await encrypted(row.name),
          value: await encrypted(row.value),
          note: await encrypted(row.note),
          deletedAt: row.deletedAt,
          projectIds: [],
        });
      }

      return new Response('not found', { status: 404 });
    },
  };
  return server;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function randomKeyPair(): SmKeyPair {
  const webCrypto = requireWebCrypto();
  return {
    encKey: webCrypto.getRandomValues(new Uint8Array(32)),
    macKey: webCrypto.getRandomValues(new Uint8Array(32)),
  };
}

function sessionFor(userKey: SmKeyPair): SessionState {
  return { symEncKey: bytesToBase64(userKey.encKey), symMacKey: bytesToBase64(userKey.macKey) } as SessionState;
}

/** 共用的固定数据；每个用例前用它重建服务端。 */
const FIXTURES: FakeSecret[] = [
  { id: 's1', name: '数据库口令', value: 'P1ain-DB-Value', note: 'P1ain-DB-Note', revisionDate: '2026-10-01T00:00:00.000Z' },
  { id: 's2', name: 'API 密钥', value: 'P1ain-Api-Value', note: '', revisionDate: '2026-10-02T00:00:00.000Z' },
];

/** 每个用例一套隔离的夹具：用户密钥 / 组织密钥 / 假服务端。 */
async function freshSetup(
  userKey: SmKeyPair
): Promise<{ session: SessionState; server: FakeServer }> {
  const orgKey = requireWebCrypto().getRandomValues(new Uint8Array(SYMMETRIC_KEY_BYTES));
  const server = createServer(orgKey, await wrapOrgKey(orgKey, userKey));
  server.secrets = FIXTURES.map((secret) => ({ ...secret }));
  // s1 有标签、s2 没有（覆盖「分组 + 未标记」两种条目）
  server.tags = { s1: '生产' };
  server.trash = [
    { id: 't1', name: '已删机密', value: 'P1ain-Trash-Value', note: '', deletedAt: '2026-10-03T00:00:00.000Z' },
  ];
  return { session: sessionFor(userKey), server };
}

/** 走一遍在线流程：拿上下文 + 列表 + 标签 + 落快照。 */
async function primeOnlineSnapshot(
  server: FakeServer,
  ctx: Awaited<ReturnType<typeof ensureSecretsContext>>,
  options?: { skipTrash?: boolean }
): Promise<void> {
  const listed = await listSecrets(server.authedFetch, ctx);
  const tags = await listSecretTags(server.authedFetch, ctx);
  await refreshSecretsOfflineSnapshot(server.authedFetch, ctx, CACHE_KEY, listed.raw, tags.raw, options);
}

test('online snapshot: stores ciphertext only and rebuilds the list offline', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  // ⭐ 落盘的字节里不能有明文
  const record = await loadSecretsOfflineCache(CACHE_KEY);
  assert.ok(record, 'snapshot must be written');
  const stored = JSON.stringify(record);
  for (const secret of FIXTURES) {
    assert.ok(!stored.includes(secret.name), `plaintext name leaked: ${secret.name}`);
    assert.ok(!stored.includes(secret.value), `plaintext value leaked: ${secret.value}`);
    if (secret.note) assert.ok(!stored.includes(secret.note), `plaintext note leaked: ${secret.note}`);
  }

  // 离线：用缓存的包裹 + 会话密钥重建上下文，再解出列表与内容
  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext, 'offline context must be rebuilt from the cached wrap');
  assert.equal(offlineContext.organizationId, ORG_ID);

  const offline = await loadOfflineSecrets(offlineContext, CACHE_KEY);
  assert.ok(offline);
  assert.deepEqual(
    offline.secrets.map((secret) => secret.name).sort(),
    ['API 密钥', '数据库口令']
  );

  const detail = await getOfflineSecretDetail(offlineContext, CACHE_KEY, 's1');
  assert.equal(detail?.value, 'P1ain-DB-Value');
  assert.equal(detail?.note, 'P1ain-DB-Note');

  const trash = await loadOfflineTrash(offlineContext, CACHE_KEY);
  assert.deepEqual(trash?.map((row) => row.name), ['已删机密']);
});

test('signature unchanged: no extra request at all', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);
  const afterFirst = server.calls.filter((url) => url.endsWith('/secrets/sync')).length;
  assert.equal(afterFirst, 1, 'first pass must fetch the full snapshot');

  // 同样的列表再走一遍：除了列表与标签本身，不该再发任何请求（尤其不能重传全量密文）
  const before = server.calls.length;
  await primeOnlineSnapshot(server, ctx);
  const after = server.calls.slice(before);
  assert.deepEqual(
    after,
    [`/api/organizations/${ORG_ID}/secrets`, '/api/secrets/tags'],
    'unchanged signature must not re-fetch the full snapshot'
  );
  assert.equal(after.some((url) => url.endsWith('/secrets/sync')), false, '不得重拉全量密文');
});

test('signature changed: the snapshot is replaced wholesale', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  server.secrets[0].name = '数据库口令（已改）';
  server.secrets[0].value = 'P1ain-DB-Value-2';
  server.secrets[0].revisionDate = '2026-10-09T00:00:00.000Z';
  server.secrets.push({
    id: 's3',
    name: '新机密',
    value: 'P1ain-New',
    note: '',
    revisionDate: '2026-10-09T01:00:00.000Z',
  });
  await primeOnlineSnapshot(server, ctx);

  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  const offline = await loadOfflineSecrets(offlineContext, CACHE_KEY);
  assert.equal(offline?.secrets.length, 3);
  const updated = await getOfflineSecretDetail(offlineContext, CACHE_KEY, 's1');
  assert.equal(updated?.name, '数据库口令（已改）');
  assert.equal(updated?.value, 'P1ain-DB-Value-2');
});

test('sync failure keeps the previous snapshot (never wipe offline data)', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  // 列表变了（签名随之变化），但同步端点故障 / 回空 ⇒ 旧快照必须原样保留
  server.secrets[0].revisionDate = '2026-10-09T00:00:00.000Z';
  server.syncFailure = 503;
  await primeOnlineSnapshot(server, ctx);
  server.syncFailure = null;
  server.syncEmpty = true;
  await primeOnlineSnapshot(server, ctx);

  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  const offline = await loadOfflineSecrets(offlineContext, CACHE_KEY);
  assert.deepEqual(
    offline?.secrets.map((secret) => secret.name).sort(),
    ['API 密钥', '数据库口令'],
    'stale-but-present beats empty'
  );
  assert.equal((await getOfflineSecretDetail(offlineContext, CACHE_KEY, 's1'))?.value, 'P1ain-DB-Value');
});

test('a different user key cannot unwrap the cached org key', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  assert.equal(await ensureOfflineSecretsContext(sessionFor(randomKeyPair()), CACHE_KEY), null);
  assert.equal(await ensureOfflineSecretsContext(session, 'unknown-cache-key'), null);
});

test('trash: only content viewed online is cached, and stale entries are dropped', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  // 没看过内容 ⇒ 离线取不到（界面提示需要联网）
  assert.equal(await getOfflineTrashedSecretDetail(offlineContext, CACHE_KEY, 't1'), null);

  await saveCachedSecretsOfflineTrashDetail(CACHE_KEY, 't1', {
    id: 't1',
    key: await encryptField('已删机密', splitKeyPair(ctx.orgKey)),
    value: await encryptField('P1ain-Trash-Value', splitKeyPair(ctx.orgKey)),
    note: '',
    deletedAt: '2026-10-03T00:00:00.000Z',
    projectIds: [],
  });
  const cached = await getOfflineTrashedSecretDetail(offlineContext, CACHE_KEY, 't1');
  assert.equal(cached?.name, '已删机密');
  assert.equal(cached?.value, 'P1ain-Trash-Value');

  // 那条不在回收站里了（永久删除）⇒ 惰性内容必须一起清掉，不能越积越多
  server.trash = [];
  server.secrets[0].revisionDate = '2026-10-09T00:00:00.000Z';
  await primeOnlineSnapshot(server, ctx);
  const record = await loadSecretsOfflineCache(CACHE_KEY);
  assert.deepEqual(record?.trashDetails, {});
});

test('an empty organization still caches the wrap (offline shows an empty list, not an error)', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  server.secrets = [];
  server.trash = [];

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  // 同步端点在「无变更」时只回 `{hasChanges:false}` —— 那不代表快照不该落盘
  const record = await loadSecretsOfflineCache(CACHE_KEY);
  assert.ok(record, 'empty org must still cache the wrapped org key');
  assert.deepEqual(record.secrets, []);

  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  const offline = await loadOfflineSecrets(offlineContext, CACHE_KEY);
  assert.deepEqual(offline?.secrets, []);
});

test('⭐ 快照函数交回它刚落盘的那批含值密文', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);

  const listed = await listSecrets(server.authedFetch, ctx);
  const tags = await listSecretTags(server.authedFetch, ctx);
  const written = await refreshSecretsOfflineSnapshot(server.authedFetch, ctx, CACHE_KEY, listed.raw, tags.raw);

  // 必须是**同一批**含值密文：内存索引直接拿它建，与缓存、与列表三者要能对上
  const record = await loadSecretsOfflineCache(CACHE_KEY);
  assert.deepEqual(written, record?.secrets);
  assert.equal(written?.length, FIXTURES.length);
  assert.ok(
    written?.every((row) => !!row.value && row.note !== undefined),
    '交回的必须是含 value / note 的完整密文'
  );

  // 签名一致那一支（不重传全量）也要交回缓存里那份，否则调用方只能再读一遍 IndexedDB
  const syncCalls = () => server.calls.filter((url) => url.endsWith('/secrets/sync')).length;
  const before = syncCalls();
  const again = await refreshSecretsOfflineSnapshot(server.authedFetch, ctx, CACHE_KEY, listed.raw, tags.raw);
  assert.equal(syncCalls(), before, '签名没变就不该重传全量密文');
  assert.deepEqual(again, written);
});

test('⭐ 「没读到」与「读到空」要能区分（前者不许清掉调用方的索引）', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);

  // 还没落过快照 ⇒ null：调用方据此**保留旧索引**，而不是换成空的（换成空的 = 点击全退回网络）
  assert.equal(await loadOfflineSecretDetails(ctx, CACHE_KEY), null);

  await primeOnlineSnapshot(server, ctx);
  const rows = await loadOfflineSecretDetails(ctx, CACHE_KEY);
  assert.equal(rows?.length, FIXTURES.length);
  assert.ok(rows?.every((row) => !!row.value), '索引要的是含值密文');

  // 组织对不上 ⇒ 同样是 null：别家的密文不是这把密钥加密的，解出来是乱码
  assert.equal(await loadOfflineSecretDetails({ ...ctx, organizationId: 'org-other' }, CACHE_KEY), null);

  // 机密被删光（同步回空是**正常**情形）⇒ 空数组，与「没读到」区分开
  server.secrets = [];
  server.trash = [];
  await primeOnlineSnapshot(server, ctx);
  assert.deepEqual(await loadOfflineSecretDetails(ctx, CACHE_KEY), []);
});

test('⭐ 标签：落盘的是密文、离线可解，且改标签不触发全量重传', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  // ① 落盘的是密文（明文标签不得出现）
  const record = await loadSecretsOfflineCache(CACHE_KEY);
  assert.ok(record);
  assert.equal(JSON.stringify(record).includes('生产'), false, '标签明文不得落盘');
  assert.ok(record.tags.s1, 's1 的标签密文应在快照里');

  // ② 离线能解出来（分组要用）
  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  const offlineTags = await loadOfflineSecretTags(offlineContext, CACHE_KEY);
  assert.deepEqual(offlineTags.tagsBySecretId, { s1: '生产' });
  assert.deepEqual(offlineTags.allTags, ['生产']);

  // ③ ⭐ 只改标签（列表签名未变）⇒ 不得重新拉全量密文
  server.tags = { s1: '生产', s2: '测试' };
  const syncCallsBefore = server.calls.filter((url) => url.endsWith('/secrets/sync')).length;
  await primeOnlineSnapshot(server, ctx);
  assert.equal(
    server.calls.filter((url) => url.endsWith('/secrets/sync')).length,
    syncCallsBefore,
    '改标签不得触发全量密文重传（标签不进签名）'
  );

  // 但标签本身要落盘（否则改完标签离线看不到）
  const afterTagChange = await loadOfflineSecretTags(offlineContext, CACHE_KEY);
  assert.deepEqual(afterTagChange.allTags, ['测试', '生产']);
});

test('⭐ 标签取不到时（null）不得清掉缓存里的标签', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  const before = await loadSecretsOfflineCache(CACHE_KEY);
  assert.ok(before?.tags.s1, '前置：缓存里应有 s1 的标签');

  // 模拟「这次标签请求失败」：调用方传 `null`（与 `listSecretTags().catch(() => null)` 同形）
  const listed = await listSecrets(server.authedFetch, ctx);
  await refreshSecretsOfflineSnapshot(server.authedFetch, ctx, CACHE_KEY, listed.raw, null);

  const after = await loadSecretsOfflineCache(CACHE_KEY);
  assert.deepEqual(after?.tags, before.tags, '取不到标签时必须保留旧值（不是当成「标签被删光了」）');
});

test('⭐ 增量：只回变更的那几条，未变的沿用缓存里的密文', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  const before = await loadSecretsOfflineCache(CACHE_KEY);
  const s2Before = before?.secrets.find((row) => row.id === 's2');
  assert.ok(s2Before);

  // 只改 s1：新时间戳晚于快照里最新那条（s2 的 10-02）
  server.secrets[0].value = 'P1ain-DB-Value-2';
  server.secrets[0].revisionDate = '2026-10-09T00:00:00.000Z';
  const beforeCalls = server.calls.length;
  await primeOnlineSnapshot(server, ctx);

  const syncCall = server.calls.slice(beforeCalls).find((url) => url.includes('/secrets/sync'));
  assert.equal(
    syncCall,
    `/api/organizations/${ORG_ID}/secrets/sync?lastSyncedDate=${encodeURIComponent('2026-10-02T00:00:00.000Z')}`,
    '增量起点取快照里最新的 revisionDate（服务端时钟，与本机时钟无关）'
  );

  const after = await loadSecretsOfflineCache(CACHE_KEY);
  assert.deepEqual(
    after?.secrets.find((row) => row.id === 's2'),
    s2Before,
    '未变的条目要逐字沿用缓存里的密文（服务端根本没回它 ⇒ 密文不会变）'
  );
  assert.equal(after?.secrets.length, 2, '不得多出或丢掉条目');

  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  assert.equal((await getOfflineSecretDetail(offlineContext, CACHE_KEY, 's1'))?.value, 'P1ain-DB-Value-2');
  assert.equal((await getOfflineSecretDetail(offlineContext, CACHE_KEY, 's2'))?.value, 'P1ain-Api-Value');
});

test('⭐ 增量补不齐（例如回收站恢复回来的老条目）⇒ 整份回全量', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  // 从回收站恢复：列表里多一条，但它的 `revision_date` 比快照起点还旧 ⇒ 增量不会回它
  server.trash = [];
  server.secrets.push({
    id: 't1',
    name: '已删机密',
    value: 'P1ain-Trash-Value',
    note: '',
    revisionDate: '2026-09-01T00:00:00.000Z',
  });
  const beforeCalls = server.calls.length;
  await primeOnlineSnapshot(server, ctx);

  const syncs = server.calls.slice(beforeCalls).filter((url) => url.includes('/secrets/sync'));
  assert.equal(syncs.length, 2, '先试增量，补不齐再回全量');
  assert.ok(syncs[0].includes('lastSyncedDate='), '第一次必须是增量');
  assert.equal(syncs[1], `/api/organizations/${ORG_ID}/secrets/sync`, '第二次退回全量');

  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  const offline = await loadOfflineSecrets(offlineContext, CACHE_KEY);
  assert.deepEqual(offline?.secrets.map((secret) => secret.name).sort(), ['API 密钥', '已删机密', '数据库口令']);
  assert.equal((await getOfflineSecretDetail(offlineContext, CACHE_KEY, 't1'))?.value, 'P1ain-Trash-Value');
});

test('⭐ 写后校准（skipTrash）：不取回收站，但密文快照照常更新', async () => {
  indexedDb.reset();
  const userKey = randomKeyPair();
  const { session, server } = await freshSetup(userKey);
  const ctx = await ensureSecretsContext(server.authedFetch, session);
  await primeOnlineSnapshot(server, ctx);

  // 机密与回收站都变了：写后校准只该管前者
  server.secrets[0].revisionDate = '2026-10-09T00:00:00.000Z';
  server.trash = [];
  const beforeCalls = server.calls.length;
  await primeOnlineSnapshot(server, ctx, { skipTrash: true });

  const calls = server.calls.slice(beforeCalls);
  assert.ok(calls.some((url) => url.includes('/secrets/sync')), '密文快照仍要更新');
  assert.equal(
    calls.some((url) => url.endsWith('/api/secrets/trash')),
    false,
    '写后校准不取回收站（在线打开回收站页另有自己的请求）'
  );

  const record = await loadSecretsOfflineCache(CACHE_KEY);
  assert.equal(record?.trash.length, 1, '回收站的离线副本保持原样，等下次完整刷新');
  const offlineContext = await ensureOfflineSecretsContext(session, CACHE_KEY);
  assert.ok(offlineContext);
  assert.deepEqual(
    (await loadOfflineSecrets(offlineContext, CACHE_KEY))?.secrets.map((secret) => secret.name).sort(),
    ['API 密钥', '数据库口令']
  );
});

test('增量的兜底：快照久未全量核对过就回全量（陈旧程度有上界）', () => {
  const source = readFileSync(new URL('../../webapp/src/lib/api/secrets.ts', import.meta.url), 'utf8');
  assert.match(source, /const SNAPSHOT_FULL_RESYNC_MS = 24 \* 60 \* 60 \* 1000;/, '要有全量兜底周期');
  assert.match(
    source,
    /Date\.now\(\) - scoped\.savedAt < SNAPSHOT_FULL_RESYNC_MS/,
    '条件是「快照比兜底周期新」才走增量'
  );
  assert.match(
    source,
    /if \(\[\.\.\.liveIds\]\.every\(\(id\) => byId\.has\(id\)\)\) secrets = \[\.\.\.byId\.values\(\)\]/,
    '合并补不齐必须退回全量，不能把缺值的快照当权威'
  );
});

test('cache never carries machine-account data', () => {
  // 设计决定：机器账号 / 访问令牌 / 授权**不随机密一起离线**（它们的凭据落盘即明文）。
  // 这是「已核实过」的结论，写成断言防退化。
  const source = readFileSync(new URL('../../webapp/src/lib/secrets-offline-cache.ts', import.meta.url), 'utf8');
  for (const forbidden of ['machineAccount', 'accessToken', 'grants', 'secretHash']) {
    assert.ok(!source.includes(forbidden), `offline cache must not persist ${forbidden}`);
  }
});

test('cleanup: restore the stub', () => {
  indexedDb.restore();
});

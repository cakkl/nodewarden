// 远端备份主路径 E2E：上传 → 列目录 → 完整性 → 从远端恢复
//
// 为什么需要：远端 6 个端点此前只有「超时与权限」被覆盖，**成功路径一个测试都没有**
// ⇒ 「远端备份到底能不能恢复」只能靠人工验收。
//
// 做法：真实 handler + 真实 Durable Object 类，只把两处外部依赖换成内存实现 ——
// `globalThis.fetch`（假 WebDAV）与 `DurableObjectState.storage`（内存 Map + 事务）。
// 恢复后与「备份前快照」逐行比对，而不是只断言接口返回 200。
//
// 运行方式：npm run test:backup-remote-roundtrip
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { BackupTransferRunner } from '../src/durable/backup-transfer-runner';
import {
  handleInspectAdminRemoteBackup,
  handleListAdminRemoteBackups,
  handleRestoreAdminRemoteBackup,
  handleRunAdminConfiguredBackup,
} from '../src/handlers/backup';
import { AuthService } from '../src/services/auth';
import { getDefaultBackupSettings, saveBackupSettings } from '../src/services/backup-config';
import type { BackupDestinationRecord } from '../src/services/backup-config';
import { StorageService } from '../src/services/storage';
import type { Env, User } from '../src/types';
import { FIXED_NOW, TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const ADMIN_ID = 'admin-1';
const ADMIN_EMAIL = 'admin@example.test';
/** 客户端派生后发上来的主密码哈希（服务端再叠一层，与登录同构）。 */
const CLIENT_HASH = 'client-side-hash-of-master-password';
const DESTINATION_ID = 'dest-webdav';
const DAV_BASE_URL = 'https://dav.example.test';
const VAULT_ORIGIN = 'https://vault.example.test';
/** `src/durable/backup-transfer-runner.ts` 的租约 key（内部常量，未导出）。 */
const BACKUP_JOB_STATE_KEY = 'backup.job.state.v1';

// ------------------------------------------------------------------ 假 WebDAV 服务器

interface StoredFile {
  bytes: Uint8Array;
  modifiedAt: string;
}

interface MemoryWebDav {
  files: Map<string, StoredFile>;
  /** 收到的请求（`METHOD path`），用来断言适配器真的走完了上传 / 校验 */
  requests: string[];
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

function multiStatusXml(files: Map<string, StoredFile>): string {
  // 解析侧要求**成对标签**（`extractXmlFirst` 不认自闭合），所以 `<D:resourcetype></D:resourcetype>`
  // 必须写成空的一对，不能写成 `<D:resourcetype/>`。
  const entries = [...files.entries()]
    .map(
      ([key, file]) =>
        `<D:response><D:href>/${key}</D:href><D:propstat><D:prop>` +
        `<D:resourcetype></D:resourcetype>` +
        `<D:getcontentlength>${file.bytes.byteLength}</D:getcontentlength>` +
        `<D:getlastmodified>${file.modifiedAt}</D:getlastmodified>` +
        `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries}</D:multistatus>`;
}

function createMemoryWebDav(): MemoryWebDav {
  const files = new Map<string, StoredFile>();
  const requests: string[] = [];

  const keyOf = (input: RequestInfo | URL): string => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return decodeURIComponent(url.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = String(init?.method || 'GET').toUpperCase();
    const key = keyOf(input);
    requests.push(`${method} ${key}`);

    if (method === 'MKCOL') return new Response(null, { status: 201 });
    if (method === 'PROPFIND') {
      if (key && ![...files.keys()].some((name) => name.startsWith(`${key}/`))) {
        return new Response('missing', { status: 404 });
      }
      const scoped = new Map([...files].filter(([name]) => !key || name.startsWith(`${key}/`)));
      return new Response(multiStatusXml(scoped), { status: 207, headers: { 'Content-Type': 'application/xml' } });
    }
    if (method === 'PUT') {
      const body = init?.body;
      const bytes = body instanceof Uint8Array
        ? new Uint8Array(body)
        : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      files.set(key, { bytes, modifiedAt: new Date(0).toUTCString() });
      return new Response(null, { status: 201 });
    }
    const file = files.get(key);
    if (method === 'HEAD') {
      return file
        ? new Response(null, {
            status: 200,
            headers: { 'Content-Length': String(file.bytes.byteLength), 'Last-Modified': file.modifiedAt },
          })
        : new Response(null, { status: 404 });
    }
    if (method === 'GET') {
      return file
        ? new Response(file.bytes, {
            status: 200,
            headers: {
              'Content-Type': 'application/zip',
              'Content-Length': String(file.bytes.byteLength),
              'Last-Modified': file.modifiedAt,
            },
          })
        : new Response('missing', { status: 404 });
    }
    if (method === 'DELETE') {
      return new Response(null, { status: files.delete(key) ? 204 : 404 });
    }
    return new Response('unsupported', { status: 500 });
  };

  return { files, requests, fetch };
}

// ------------------------------------------------------------------ 假 DO 存储

function createDurableObjectState(): { state: DurableObjectState; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const api = {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
  };
  const storage = { ...api, transaction: async <T>(fn: (txn: typeof api) => Promise<T>): Promise<T> => fn(api) };
  return { state: { storage } as unknown as DurableObjectState, store };
}

// ------------------------------------------------------------------ 夹具

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  env: Env;
  dav: MemoryWebDav;
  doStore: Map<string, unknown>;
  admin: User;
}

function seedData(connection: DatabaseSync): void {
  // 两步登录偏好用**非默认值**：否则「恢复后回到原值」会被 NULL / 0 平凡通过
  connection
    .prepare('UPDATE users SET two_factor_email_enabled = 1, two_factor_default_provider = 3 WHERE id = ?')
    .run(ADMIN_ID);
  connection
    .prepare('INSERT INTO folders (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('folder-1', ADMIN_ID, 'enc-folder', FIXED_NOW, FIXED_NOW);
  connection
    .prepare('INSERT INTO domain_settings (user_id, equivalent_domains, custom_equivalent_domains, excluded_global_equivalent_domains, updated_at) VALUES (?,?,?,?,?)')
    .run(ADMIN_ID, '[[1,[2]]]', '[]', '[]', FIXED_NOW);
  connection
    .prepare('INSERT INTO user_revisions (user_id, revision_date) VALUES (?,?)')
    .run(ADMIN_ID, FIXED_NOW);
  connection
    .prepare(
      'INSERT INTO ciphers (id, user_id, type, folder_id, name, notes, favorite, data, reprompt, key, created_at, updated_at, archived_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run('cipher-1', ADMIN_ID, 1, 'folder-1', 'enc-name', 'enc-notes', 0, JSON.stringify({ name: 'enc-name', type: 1 }), null, 'enc-key', FIXED_NOW, FIXED_NOW, null, null);
  connection
    .prepare(
      'INSERT INTO webauthn_credentials (id, user_id, purpose, name, public_key, credential_id, counter, type, aa_guid, transports, encrypted_user_key, encrypted_public_key, encrypted_private_key, supports_prf, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run('cred-1', ADMIN_ID, 'login', 'YubiKey', 'pub', 'cred-id', 0, 'public-key', 'aa', '[]', 'usk', 'pub', 'priv', 0, FIXED_NOW, FIXED_NOW);
}

function webdavDestination(): BackupDestinationRecord {
  return {
    id: DESTINATION_ID,
    name: 'Test WebDAV',
    type: 'webdav',
    includeAttachments: false,
    destination: {
      baseUrl: DAV_BASE_URL,
      username: 'user',
      password: 'secret',
      remotePath: '',
    },
    schedule: { enabled: false, intervalHours: 24, startTime: '03:00', timezone: 'UTC', retentionCount: null },
    runtime: {
      lastAttemptAt: null,
      lastAttemptLocalDate: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastUploadedFileName: null,
      lastUploadedSizeBytes: null,
      lastUploadedDestination: null,
    },
  };
}

async function setup(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  const dav = createMemoryWebDav();
  const runner = createDurableObjectState();
  const env = {
    DB: handle.db,
    JWT_SECRET: TEST_JWT_SECRET,
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
    BACKUP_TRANSFER_RUNNER: {
      idFromName: (name: string) => ({ toString: () => name }),
      // 委派给**真实** DO 类 ⇒ 租约、进度、错误映射都是生产代码在跑。
      // ⚠️ handler 调的是 `stub.fetch(url, init)` 两参 ⇒ 桩要自己拼 `Request`，
      // 否则 DO 里 `new URL(request.url)` 抛 `Invalid URL`（表现为一个 500）。
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          new BackupTransferRunner(runner.state, env).fetch(new Request(input as RequestInfo, init)),
      }),
    },
  } as unknown as Env;

  insertUser(handle.connection, ADMIN_ID, {
    email: ADMIN_EMAIL,
    masterPasswordHash: await new AuthService(env).hashPasswordServer(CLIENT_HASH),
    role: 'admin',
  });
  seedData(handle.connection);

  const storage = new StorageService(env.DB);
  const settings = getDefaultBackupSettings('UTC');
  settings.destinations = [webdavDestination()];
  await saveBackupSettings(storage, env, settings);

  const admin = await storage.getUserById(ADMIN_ID);
  assert.ok(admin, '管理员应能被读出');

  return { handle, env, dav, doStore: runner.store, admin };
}

/** 只在这段里把 `fetch` 换成假 WebDAV 服务器，避免影响其它请求（审计通知等）。 */
async function withDav<T>(harness: Harness, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = harness.dav.fetch as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${VAULT_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runBackup(harness: Harness): Promise<{ fileName: string; fileSize: number; remotePath: string }> {
  const response = await withDav(harness, () =>
    handleRunAdminConfiguredBackup(
      jsonRequest('/api/admin/backup/run', { destinationId: DESTINATION_ID, masterPasswordHash: CLIENT_HASH }),
      harness.env,
      harness.admin
    )
  );
  const raw = await response.text();
  assert.equal(response.status, 200, `备份应成功，实际 ${response.status}：${raw}`);
  const body = JSON.parse(raw) as { object: string; result: { fileName: string; fileSize: number; remotePath: string } };
  assert.equal(body.object, 'backup-run');
  return body.result;
}

const SNAPSHOT_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['users', 'id'],
  ['folders', 'id'],
  ['ciphers', 'id'],
  ['webauthn_credentials', 'id'],
  ['domain_settings', 'user_id'],
  ['user_revisions', 'user_id'],
];

function snapshot(connection: DatabaseSync): Record<string, unknown[]> {
  return Object.fromEntries(
    SNAPSHOT_TABLES.map(([table, orderBy]) => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()])
  );
}

// ------------------------------------------------------------------ 用例

test('远端备份：一次手动备份把归档写到远端，文件名与大小与归档一致', async () => {
  const harness = await setup();
  try {
    const result = await runBackup(harness);

    assert.equal(harness.dav.files.size, 1, '远端应当只有一个归档');
    const [key, file] = [...harness.dav.files.entries()][0];
    assert.equal(key, result.remotePath, '上传路径应与返回的 remotePath 一致');
    assert.match(key, /\.zip$/, '归档必须是 zip');
    assert.equal(file.bytes.byteLength, result.fileSize, '远端字节数应与返回的 fileSize 一致');
    assert.ok(result.fileName.endsWith('.zip'));
  } finally {
    harness.handle.close();
  }
});

test('远端浏览与完整性：列目录能看到该归档，完整性校验通过（都要求主密码）', async () => {
  const harness = await setup();
  try {
    const result = await runBackup(harness);

    const listResponse = await withDav(harness, () =>
      handleListAdminRemoteBackups(
        new Request(`${VAULT_ORIGIN}/api/admin/backup/remote?destinationId=${DESTINATION_ID}`),
        harness.env,
        harness.admin
      )
    );
    assert.equal(listResponse.status, 200);
    const listing = (await listResponse.json()) as { items: Array<{ path: string; size: number | null; isDirectory: boolean }> };
    const entry = listing.items.find((item) => item.path === result.remotePath);
    assert.ok(entry, '列目录应能看到刚上传的归档');
    assert.equal(entry.size, result.fileSize);
    assert.equal(entry.isDirectory, false);

    // 主密码校验：缺失与错误都必须被拒（否则「看一眼归档」就成了无需再确认的操作）
    for (const wrong of [{}, { masterPasswordHash: 'not-the-password' }]) {
      const denied = await withDav(harness, () =>
        handleInspectAdminRemoteBackup(
          jsonRequest('/api/admin/backup/remote/integrity', { destinationId: DESTINATION_ID, path: result.remotePath, ...wrong }),
          harness.env,
          harness.admin
        )
      );
      assert.equal(denied.status, 400, '缺主密码或密码错必须拒绝');
    }

    const integrityResponse = await withDav(harness, () =>
      handleInspectAdminRemoteBackup(
        jsonRequest('/api/admin/backup/remote/integrity', {
          destinationId: DESTINATION_ID,
          path: result.remotePath,
          masterPasswordHash: CLIENT_HASH,
        }),
        harness.env,
        harness.admin
      )
    );
    assert.equal(integrityResponse.status, 200);
    const integrity = (await integrityResponse.json()) as {
      integrity: { hasChecksumPrefix: boolean; matches: boolean };
    };
    assert.equal(integrity.integrity.hasChecksumPrefix, true, '归档文件名应带校验和前缀');
    assert.equal(integrity.integrity.matches, true, '完整性校验应通过');
  } finally {
    harness.handle.close();
  }
});

test('从远端恢复：数据被改乱后恢复，逐行回到备份前状态（含两步登录偏好）', async () => {
  const harness = await setup();
  try {
    const before = snapshot(harness.handle.connection);
    const result = await runBackup(harness);

    // 改乱：删表数据 + 把两步登录偏好清空（新列必须跟着回来，否则「默认方式」会在恢复后丢失）
    harness.handle.connection.prepare('DELETE FROM folders').run();
    harness.handle.connection.prepare("UPDATE ciphers SET name = 'tampered'").run();
    harness.handle.connection
      .prepare('UPDATE users SET two_factor_default_provider = NULL, two_factor_email_enabled = 0 WHERE id = ?')
      .run(ADMIN_ID);
    assert.notDeepStrictEqual(snapshot(harness.handle.connection), before, '改乱应真的生效');

    const response = await withDav(harness, () =>
      handleRestoreAdminRemoteBackup(
        jsonRequest('/api/admin/backup/remote/restore', {
          destinationId: DESTINATION_ID,
          path: result.remotePath,
          replaceExisting: true,
          masterPasswordHash: CLIENT_HASH,
        }),
        harness.env,
        harness.admin
      )
    );
    const raw = await response.text();
    assert.equal(response.status, 200, `恢复应成功，实际 ${response.status}：${raw}`);

    const after = snapshot(harness.handle.connection);
    for (const [table] of SNAPSHOT_TABLES) {
      assert.deepStrictEqual(after[table], before[table], `${table} 未回到备份前状态`);
    }
    // 单独把新列再钉一次：它是「远端恢复后默认方式不丢」的唯一证据
    const user = harness.handle.connection
      .prepare('SELECT two_factor_default_provider AS provider, two_factor_email_enabled AS email FROM users WHERE id = ?')
      .get(ADMIN_ID) as { provider: number | null; email: number };
    assert.equal(user.provider, 3, '恢复后「默认方式」必须回到备份时的值');
    assert.equal(user.email, 1, '恢复后邮件两步登录开关必须回到备份时的值');

    // 恢复过程确实从远端读了字节（而不是用了本地残留）
    assert.ok(harness.dav.requests.some((entry) => entry.startsWith('GET ')), '恢复应当从远端下载归档');
  } finally {
    harness.handle.close();
  }
});

test('远端备份：DO 租约未过期时返回 409，而不是重复跑一遍', async () => {
  const harness = await setup();
  try {
    // 预置一份未过期的租约（= 另一次备份正在跑）
    harness.doStore.set(BACKUP_JOB_STATE_KEY, {
      token: 'other-run',
      reason: 'manual',
      acquiredAt: new Date().toISOString(),
      touchedAt: new Date().toISOString(),
      expiresAtMs: Date.now() + 60_000,
    });

    const response = await withDav(harness, () =>
      handleRunAdminConfiguredBackup(
        jsonRequest('/api/admin/backup/run', { destinationId: DESTINATION_ID, masterPasswordHash: CLIENT_HASH }),
        harness.env,
        harness.admin
      )
    );
    assert.equal(response.status, 409, '并发备份必须被租约挡住');
    assert.equal(harness.dav.files.size, 0, '被挡住时不该真的上传');
  } finally {
    harness.handle.close();
  }
});

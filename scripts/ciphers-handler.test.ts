// ciphers handler 的行为测试
//
// 用**真实 SQL**（node:sqlite 适配器 + migrations/0001_init.sql）驱动真实 handler，重点三件事：
//   ① **跨用户隔离** —— 越权读写必须 404 且数据分毫不变
//   ② **陈旧写入** —— 过期的 lastKnownRevisionDate 必须被拒绝
//   ③ **未知字段保留** —— CONTRIBUTING 的硬性要求（Bitwarden 兼容面）
//
// 运行方式：npm run test:ciphers-handler
// 必须带 `--import ./scripts/lib/register-cloudflare-stub.mjs`：`ciphers.ts` 间接 import
// `cloudflare:workers`，Node 无法解析该协议（package.json 里已固化）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

import {
  handleCreateCipher,
  handleDeleteCipherCompat,
  handleGetCipher,
  handleRestoreCipher,
  handleUpdateCipher,
} from '../src/handlers/ciphers';
import type { Env } from '../src/types';
import { createD1SqliteDatabase } from './lib/d1-sqlite';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0001_init.sql'), 'utf8');
const NOW = '2026-01-01T00:00:00.000Z';

const USER_A = 'user-a';
const USER_B = 'user-b';

/** 远早于任何 updated_at，用于触发 stale 检查（判定阈值是差值 >1000ms） */
const STALE_REVISION = '2020-01-01T00:00:00.000Z';

/**
 * 生成合法的 Bitwarden EncString。
 * 服务端会校验"加密串"格式（`validateCipherEncryptedFieldsForCompatibility`）：
 * type 2 = AES-CBC-HMAC，需 `2.<iv>|<data>|<mac>` 三段。传明文会被 400 拒绝。
 */
function enc(label: string): string {
  return `2.${label}-iv|${label}-data|${label}-mac`;
}

interface Harness {
  handle: ReturnType<typeof createD1SqliteDatabase>;
  env: Env;
  connection: DatabaseSync;
}

function createHarness(): Harness {
  const handle = createD1SqliteDatabase();
  handle.connection.exec(SCHEMA_SQL);
  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    handle.connection
      .prepare(
        'INSERT INTO users (id, email, name, master_password_hash, key, kdf_type, kdf_iterations, security_stamp, role, status, verify_devices, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(id, email, id, 'master-hash', 'wrapped-key', 0, 600000, `stamp-${id}`, 'user', 'active', 0, NOW, NOW);
  }

  // 桩掉 NOTIFICATIONS_HUB：handler 在写操作后会发通知，缺绑定虽被 try/catch 吞掉，
  // 但会往 stderr 打一堆堆栈、淹没有用信息。给它一个空实现更接近生产形态。
  const notificationsHub = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
  };

  return {
    handle,
    env: { DB: handle.db, NOTIFICATIONS_HUB: notificationsHub } as unknown as Env,
    connection: handle.connection,
  };
}

function jsonRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://vault.example.test/api/ciphers', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
  });
}

async function callCreate(env: Env, userId: string, body: Record<string, unknown>) {
  const response = await handleCreateCipher(jsonRequest(body), env, userId);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function callUpdate(env: Env, userId: string, id: string, body: Record<string, unknown>) {
  const response = await handleUpdateCipher(jsonRequest(body, 'PUT'), env, userId, id);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function cipherRow(connection: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return connection.prepare('SELECT * FROM ciphers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

function cipherData(connection: DatabaseSync, id: string): Record<string, unknown> {
  const row = cipherRow(connection, id);
  assert.ok(row, `ciphers 表中缺少 ${id}`);
  return JSON.parse(String(row.data)) as Record<string, unknown>;
}

/** 建一个属于 USER_A 的 login 类型条目，返回其 id */
async function seedCipher(h: Harness, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await callCreate(h.env, USER_A, {
    type: 1,
    name: enc('name'),
    notes: enc('notes'),
    login: { username: enc('username'), password: enc('password') },
    ...extra,
  });
  assert.equal(created.status, 200, `创建应成功，实际 ${created.status}：${JSON.stringify(created.body)}`);
  return String(created.body.id);
}

// ---------------------------------------------------------------- 创建与读取

test('创建：cipher.key 非法时的文案必须归因正确，且已登记 i18n（服务器其实**支持**逐项密钥）', async () => {
  const h = createHarness();

  // ① 合法 EncString ⇒ 接受并**原样入库**。这就是"服务器支持逐项密钥"的直接证据
  //    （config-response.ts 的 'cipher-key-encryption': true 与之相符）。
  const itemKey = enc('item-key');
  const accepted = await callCreate(h.env, USER_A, { type: 1, name: enc('name'), key: itemKey });
  assert.equal(accepted.status, 200, `合法 cipher.key 应被接受：${JSON.stringify(accepted.body)}`);
  assert.equal(cipherRow(h.connection, String(accepted.body.id))?.key, itemKey, '合法 key 必须原样入库');

  // ② 畸形值 ⇒ 400，且**不得**再说"服务器不支持逐项密钥"（旧文案既归错因、又给了无效建议）
  const rejected = await callCreate(h.env, USER_A, { type: 1, name: enc('name'), key: 'not-an-encstring' });
  assert.equal(rejected.status, 400);
  const message = String(rejected.body.error || '');
  assert.match(message, /not a valid encrypted string/i, `文案应指出"值不是合法加密串"，实际：${message}`);
  assert.doesNotMatch(message, /not supported/i, '不得再声称"不支持逐项密钥"（错误归因）');

  // ③ 文案必须登记到前端 i18n 映射表，且 10 个语言包都有该键
  //    （前端靠「英文字符串 → i18n 键」查表本地化后端错误，未命中就原样显示英文）
  const source = readFileSync(path.join(REPO_ROOT, 'src/handlers/ciphers.ts'), 'utf8');
  const declared = source.match(/const INVALID_CIPHER_KEY_MESSAGE\s*=\s*\n?\s*'([^']+)'/)?.[1];
  assert.ok(declared, '应能从 ciphers.ts 提取 INVALID_CIPHER_KEY_MESSAGE');
  assert.equal(declared, message, '响应文案应与常量一致（避免两处副本漂移）');

  const escaped = declared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const i18nSource = readFileSync(path.join(REPO_ROOT, 'webapp/src/lib/i18n.ts'), 'utf8');
  const mapped = i18nSource.match(new RegExp(`'${escaped}':\\s*'([^']+)'`))?.[1];
  assert.ok(mapped, `i18n 映射表缺少该后端文案的条目：${declared}`);

  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'fi', 'de', 'fr', 'it', 'sv']) {
    const localeSource = readFileSync(path.join(REPO_ROOT, `webapp/src/lib/i18n/locales/${locale}.ts`), 'utf8');
    assert.ok(localeSource.includes(`"${mapped}"`), `${locale} 缺少键 ${mapped}`);
  }

  h.handle.close();
});

test('创建：服务端接管 id/userId/时间戳，且保留客户端未知字段', async () => {
  const h = createHarness();
  const created = await callCreate(h.env, USER_A, {
    type: 1,
    name: enc('name'),
    login: { username: enc('u') },
    futureClientField: 'keep-me',
    nested: { deep: [1, 2] },
  });

  assert.equal(created.status, 200);
  const id = String(created.body.id);
  assert.ok(id, '响应应含服务端生成的 id');

  const row = cipherRow(h.connection, id);
  assert.ok(row, '应写入 ciphers 表');
  assert.equal(row.user_id, USER_A, 'userId 必须取自会话参数，而不是客户端');
  assert.equal(row.type, 1);
  assert.equal(row.deleted_at, null, '新建条目不应是已删除状态');

  const data = cipherData(h.connection, id);
  assert.equal(data.futureClientField, 'keep-me', '客户端未知字段必须保留（CONTRIBUTING 硬性要求）');
  assert.deepStrictEqual(data.nested, { deep: [1, 2] });

  h.handle.close();
});

test('创建：客户端伪造的 userId 必须被服务端覆盖', async () => {
  const h = createHarness();
  const forged = await callCreate(h.env, USER_A, {
    type: 1,
    name: enc('forged'),
    userId: USER_B,
  });

  assert.equal(forged.status, 200);
  assert.equal(
    cipherRow(h.connection, String(forged.body.id))?.user_id,
    USER_A,
    '客户端传入的 userId 必须被覆盖，否则可写入他人数据'
  );

  h.handle.close();
});

test('读取：所有者能读到，非所有者 404', async () => {
  const h = createHarness();
  const id = await seedCipher(h);

  const owner = await handleGetCipher(jsonRequest(null, 'GET'), h.env, USER_A, id);
  assert.equal(owner.status, 200);

  const stranger = await handleGetCipher(jsonRequest(null, 'GET'), h.env, USER_B, id);
  assert.equal(stranger.status, 404, '非所有者读取必须 404（而不是 200 或 500）');

  h.handle.close();
});

// ---------------------------------------------------------------- 跨用户隔离

test('跨用户写入必须 404，且目标数据分毫不变', async () => {
  const h = createHarness();
  const id = await seedCipher(h);
  const before = { ...cipherRow(h.connection, id)! };

  const attempt = await callUpdate(h.env, USER_B, id, { type: 1, name: enc('hijacked') });
  assert.equal(attempt.status, 404, '非所有者更新必须 404');

  assert.deepStrictEqual({ ...cipherRow(h.connection, id)! }, before, '被拒绝的写入不得改动任何数据');
  h.handle.close();
});

test('跨用户删除必须 404，且数据仍在', async () => {
  const h = createHarness();
  const id = await seedCipher(h);

  const attempt = await handleDeleteCipherCompat(jsonRequest(null, 'DELETE'), h.env, USER_B, id);
  assert.equal(attempt.status, 404, '非所有者删除必须 404');

  const row = cipherRow(h.connection, id);
  assert.ok(row, '数据不应被删除');
  assert.equal(row.deleted_at, null, '也不应被软删除');

  h.handle.close();
});

test('跨用户恢复必须 404，且数据仍是已删除状态', async () => {
  const h = createHarness();
  const id = await seedCipher(h);
  await handleDeleteCipherCompat(jsonRequest(null, 'DELETE'), h.env, USER_A, id);

  const attempt = await handleRestoreCipher(jsonRequest(null, 'PUT'), h.env, USER_B, id);
  assert.equal(attempt.status, 404, '非所有者恢复必须 404');
  assert.ok(cipherRow(h.connection, id)?.deleted_at, '数据应仍是已删除状态');

  h.handle.close();
});

// ---------------------------------------------------------------- 陈旧写入

test('陈旧的 lastKnownRevisionDate 必须被拒绝，且数据不变', async () => {
  const h = createHarness();
  const id = await seedCipher(h);
  const before = { ...cipherRow(h.connection, id)! };

  const stale = await callUpdate(h.env, USER_A, id, {
    type: 1,
    name: enc('overwritten-by-stale-client'),
    lastKnownRevisionDate: STALE_REVISION,
  });
  assert.equal(stale.status, 400, `陈旧写入应被拒绝，实际 ${stale.status}`);
  assert.match(String(stale.body.error), /out of date/i, '应提示客户端重新同步');

  assert.deepStrictEqual({ ...cipherRow(h.connection, id)! }, before, '被拒绝的陈旧写入不得改动数据');
  h.handle.close();
});

test('revisionDate 足够新时应被接受', async () => {
  const h = createHarness();
  const id = await seedCipher(h);
  const current = String(cipherRow(h.connection, id)?.updated_at);

  const ok = await callUpdate(h.env, USER_A, id, {
    type: 1,
    name: enc('updated-name'),
    lastKnownRevisionDate: current,
  });
  assert.equal(ok.status, 200, `revisionDate 足够新时应接受，实际 ${ok.status}：${JSON.stringify(ok.body)}`);

  h.handle.close();
});

test('不传 revisionDate 时不做陈旧判定（客户端可省略该字段）', async () => {
  const h = createHarness();
  const id = await seedCipher(h);

  const ok = await callUpdate(h.env, USER_A, id, { type: 1, name: enc('without-revision') });
  assert.equal(ok.status, 200, '省略 lastKnownRevisionDate 不应被当作陈旧');

  h.handle.close();
});

// ---------------------------------------------------------------- 未知字段与字段语义

test('更新时同时保留「既有未知字段」与「本次新增未知字段」', async () => {
  const h = createHarness();
  const id = await seedCipher(h, { originalUnknown: 'from-create' });

  const updated = await callUpdate(h.env, USER_A, id, {
    type: 1,
    name: enc('updated-name'),
    newlyAddedUnknown: 'from-update',
  });
  assert.equal(updated.status, 200);

  const data = cipherData(h.connection, id);
  assert.equal(data.originalUnknown, 'from-create', '既有未知字段必须保留');
  assert.equal(data.newlyAddedUnknown, 'from-update', '本次新增的未知字段也必须保留');

  h.handle.close();
});

test('全量更新中省略 notes 表示清空（replacement 语义，而非"保持原值"）', async () => {
  const h = createHarness();
  const id = await seedCipher(h); // seedCipher 带了 notes
  assert.ok(cipherRow(h.connection, id)?.notes, '前置条件：创建时应写入 notes');

  const updated = await callUpdate(h.env, USER_A, id, { type: 1, name: enc('no-notes') });
  assert.equal(updated.status, 200);

  assert.equal(
    cipherRow(h.connection, id)?.notes,
    null,
    '该端点对可空字段使用替换语义：客户端省略即视为清空（否则"清空备注"永远无法生效）'
  );

  h.handle.close();
});

// ---------------------------------------------------------------- 软删除与恢复

test('软删除与恢复：只改 deleted_at，不物理删除', async () => {
  const h = createHarness();
  const id = await seedCipher(h);

  const deleted = await handleDeleteCipherCompat(jsonRequest(null, 'DELETE'), h.env, USER_A, id);
  assert.equal(deleted.status, 200);
  assert.ok(cipherRow(h.connection, id)?.deleted_at, '软删除应写入 deleted_at');
  assert.ok(cipherRow(h.connection, id), '不应物理删除行');

  const restored = await handleRestoreCipher(jsonRequest(null, 'PUT'), h.env, USER_A, id);
  assert.equal(restored.status, 200);
  assert.equal(cipherRow(h.connection, id)?.deleted_at, null, '恢复应清空 deleted_at');

  h.handle.close();
});

// 移除「多租户预留」后的升级路径（2026-10-10）：① `sm_secret_access` 由 DROP 清掉；② `sm_org_keys`
// 去掉 `user_id` + 复合主键（SQLite 改不了主键 ⇒ 守卫 + 原子重建）。
// ⚠️ ② 必须单独测：`CREATE TABLE IF NOT EXISTS` 会跳过已存在的表，老库于是留着 `user_id NOT NULL`，
// 新代码不再写它 ⇒「组织已建、密钥行未写」时 `INSERT OR IGNORE` 静默丢弃，首次进入机密管理器报错。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

import { ensureStorageSchema } from '../src/services/storage-schema';
import { getOrgKey, saveOrgKey } from '../src/services/storage-secrets-repo';
import { createD1SqliteDatabase } from './lib/d1-sqlite';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0001_init.sql'), 'utf8');
const NOW = '2026-01-01T00:00:00.000Z';

function columnsOf(conn: DatabaseSync, table: string): string[] {
  return (conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

function tableExists(conn: DatabaseSync, table: string): boolean {
  const row = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

/** 完整基线 + 把两处退回旧形态：`sm_org_keys` 带 user_id/复合主键、`sm_secret_access` 还在。 */
function legacyDatabase(withOrgKeyRow: boolean) {
  const handle = createD1SqliteDatabase();
  const conn = handle.connection;
  conn.exec(SCHEMA_SQL);
  conn.exec(`
    DROP TABLE sm_org_keys;
    CREATE TABLE sm_org_keys (
      org_id TEXT NOT NULL, user_id TEXT NOT NULL, wrapped_org_key TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id),
      FOREIGN KEY (org_id) REFERENCES sm_organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE sm_secret_access (
      secret_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, permission TEXT NOT NULL,
      PRIMARY KEY (secret_id, principal_type, principal_id),
      FOREIGN KEY (secret_id) REFERENCES sm_secrets(id) ON DELETE CASCADE
    );
    INSERT INTO users (id, email, name, master_password_hash, key, kdf_type, kdf_iterations, security_stamp, role, created_at, updated_at)
      VALUES ('user-1', 'alice@example.test', 'Alice', 'h', 'k', 0, 600000, 'stamp', 'user', '${NOW}', '${NOW}');
    INSERT INTO sm_organizations VALUES ('org-1', 'user-1', '${NOW}');
  `);
  if (withOrgKeyRow) {
    conn.exec(`INSERT INTO sm_org_keys VALUES ('org-1', 'user-1', 'wrapped-old', '${NOW}')`);
  }
  return handle;
}

test('老库有密钥行：重建后 user_id 消失、包裹保留', async () => {
  const handle = legacyDatabase(true);
  await ensureStorageSchema(handle.db);

  assert.ok(!columnsOf(handle.connection, 'sm_org_keys').includes('user_id'), 'user_id 列应被移除');
  const row = handle.connection.prepare('SELECT org_id, wrapped_org_key FROM sm_org_keys').get() as Record<string, unknown>;
  assert.deepStrictEqual({ ...row }, { org_id: 'org-1', wrapped_org_key: 'wrapped-old' }, '包裹必须原样保留');
  handle.close();
});

test('⭐ 老库没有密钥行：重建后仍能正常写入（否则首次进入机密管理器会报错）', async () => {
  const handle = legacyDatabase(false);
  await ensureStorageSchema(handle.db);

  // 这正是旧代码踩的坑：老表 user_id NOT NULL，新代码不写它 ⇒ INSERT OR IGNORE 静默丢弃
  const saved = await saveOrgKey(handle.db, 'org-1', 'wrapped-new');
  assert.equal(saved.wrappedOrgKey, 'wrapped-new');
  assert.equal((await getOrgKey(handle.db, 'org-1'))?.wrappedOrgKey, 'wrapped-new');
  handle.close();
});

test('老库的 sm_secret_access 被清掉（新装也不再建）', async () => {
  const handle = legacyDatabase(true);
  assert.ok(tableExists(handle.connection, 'sm_secret_access'), '前置：老库里确实有这张表');

  await ensureStorageSchema(handle.db);

  assert.ok(!tableExists(handle.connection, 'sm_secret_access'), '预留表应被 DROP');
  handle.close();
});

test('重建是幂等的：连续两次 ensureStorageSchema 不报错、数据不变', async () => {
  const handle = legacyDatabase(true);
  await ensureStorageSchema(handle.db);
  await ensureStorageSchema(handle.db);

  const rows = handle.connection.prepare('SELECT * FROM sm_org_keys').all();
  assert.equal(rows.length, 1);
  assert.ok(!columnsOf(handle.connection, 'sm_org_keys').includes('user_id'));
  handle.close();
});

test('新装（迁移文件已给新形状）不会被重建', async () => {
  const handle = createD1SqliteDatabase();
  handle.connection.exec(SCHEMA_SQL);

  await ensureStorageSchema(handle.db);

  assert.deepStrictEqual(columnsOf(handle.connection, 'sm_org_keys'), ['org_id', 'wrapped_org_key', 'created_at']);
  handle.close();
});

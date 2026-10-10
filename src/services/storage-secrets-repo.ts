import { generateUUID } from '../utils/uuid';

/**
 * 机密管理器的存储层。
 *
 * **隐式组织**：每个用户恰好一个（`owner_user_id` UNIQUE），只为满足「SM 是组织级产品」的
 * 契约形态 —— 组织 id 要进 JWT 与 URL 路径。组织不暴露成员概念：owner 就是唯一成员。
 * 组织密钥由**用户的密码库密钥**包裹后存 `sm_org_keys`，服务端不接触明文。
 */

export interface SmOrganization {
  id: string;
  ownerUserId: string;
  createdAt: string;
}

/** 组织密钥的用户侧包裹：`wrappedOrgKey` 是 EncString type 2，客户端解开后才能解密机密。 */
export interface SmOrgKey {
  orgId: string;
  wrappedOrgKey: string;
  createdAt: string;
}

function mapOrganizationRow(row: any): SmOrganization {
  return { id: row.id, ownerUserId: row.owner_user_id, createdAt: row.created_at };
}

function mapOrgKeyRow(row: any): SmOrgKey {
  return { orgId: row.org_id, wrappedOrgKey: row.wrapped_org_key, createdAt: row.created_at };
}

export async function getImplicitOrganization(db: D1Database, userId: string): Promise<SmOrganization | null> {
  const row = await db
    .prepare('SELECT id, owner_user_id, created_at FROM sm_organizations WHERE owner_user_id = ?')
    .bind(userId)
    .first<any>();
  return row ? mapOrganizationRow(row) : null;
}

/** 按 id 取组织。⚠️ 给**程序侧**推送用：那条路只有 org id，需反查 `owner_user_id`（隐式组织与用户 1:1）。 */
export async function getOrganizationById(db: D1Database, orgId: string): Promise<SmOrganization | null> {
  const row = await db
    .prepare('SELECT id, owner_user_id, created_at FROM sm_organizations WHERE id = ?')
    .bind(orgId)
    .first<any>();
  return row ? mapOrganizationRow(row) : null;
}

/**
 * 组织属主的账号状态；`null` = 组织不存在。
 * ⚠️ 程序侧每次认证都看它：封禁属主 = 停掉他名下所有机器账号（与 Web 侧 403 同口径）。
 */
export async function getOrganizationOwnerStatus(db: D1Database, orgId: string): Promise<'active' | 'banned' | null> {
  const row = await db
    .prepare('SELECT u.status FROM sm_organizations o INNER JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?')
    .bind(orgId)
    .first<{ status: string }>();
  if (!row) return null;
  return row.status === 'banned' ? 'banned' : 'active';
}

/**
 * 取回（必要时创建）隐式组织。
 *
 * ⚠️ 并发安全靠 `owner_user_id` 的 UNIQUE 约束 + `INSERT OR IGNORE`：同时打进来的两个
 * 请求不会各建一个组织，二者回读后拿到同一个 id。不要改成「先查再插」。
 */
export async function ensureImplicitOrganization(db: D1Database, userId: string): Promise<SmOrganization> {
  const existing = await getImplicitOrganization(db, userId);
  if (existing) return existing;

  await db
    .prepare('INSERT OR IGNORE INTO sm_organizations(id, owner_user_id, created_at) VALUES(?, ?, ?)')
    .bind(generateUUID(), userId, new Date().toISOString())
    .run();

  const stored = await getImplicitOrganization(db, userId);
  if (!stored) throw new Error('Secrets manager organization could not be ensured');
  return stored;
}

export async function getOrgKey(db: D1Database, orgId: string): Promise<SmOrgKey | null> {
  const row = await db
    .prepare('SELECT org_id, wrapped_org_key, created_at FROM sm_org_keys WHERE org_id = ?')
    .bind(orgId)
    .first<any>();
  return row ? mapOrgKeyRow(row) : null;
}

/**
 * 写入组织密钥包裹，返回**实际存储**的那一份。
 *
 * ⚠️ `INSERT OR IGNORE` + 回读：两个标签页（或设备）并发首次初始化会各自生成一把密钥，
 * 覆盖写会让先写那方的密文**永久解不开**。首次写入胜出，后来者回读到同一把。
 * 组织密钥在本设计里不轮换，所以「覆盖成新密钥」不是需要保留的能力。
 */
export async function saveOrgKey(db: D1Database, orgId: string, wrappedOrgKey: string): Promise<SmOrgKey> {
  await db
    .prepare('INSERT OR IGNORE INTO sm_org_keys(org_id, wrapped_org_key, created_at) VALUES(?, ?, ?)')
    .bind(orgId, wrappedOrgKey, new Date().toISOString())
    .run();

  const stored = await getOrgKey(db, orgId);
  if (!stored) throw new Error('Secrets manager organization key could not be saved');
  return stored;
}
/** secret 本体。`deletedAt` 非空 = 在 Trash 里（软删，满 30 天由 scheduled 清理）。 */
export interface SmSecret {
  id: string;
  orgId: string;
  keyEncrypted: string;
  valueEncrypted: string;
  noteEncrypted: string;
  createdAt: string;
  revisionDate: string;
  deletedAt: string | null;
}

const SECRET_COLUMNS =
  'id, org_id, key_encrypted, value_encrypted, note_encrypted, created_at, revision_date, deleted_at';

function mapSecretRow(row: any): SmSecret {
  return {
    id: row.id,
    orgId: row.org_id,
    keyEncrypted: row.key_encrypted,
    valueEncrypted: row.value_encrypted,
    noteEncrypted: row.note_encrypted,
    createdAt: row.created_at,
    revisionDate: row.revision_date,
    deletedAt: row.deleted_at,
  };
}

/** 列出组织内**未删除**的 secret。 */
export async function listOrgSecrets(db: D1Database, orgId: string): Promise<SmSecret[]> {
  const result = await db
    .prepare(`SELECT ${SECRET_COLUMNS} FROM sm_secrets WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at`)
    .bind(orgId)
    .all<any>();
  return (result.results ?? []).map(mapSecretRow);
}

/** 列出挂在某 project 下的未删除 secret。 */
export async function listProjectSecrets(db: D1Database, orgId: string, projectId: string): Promise<SmSecret[]> {
  const result = await db
    .prepare(
      'SELECT s.id, s.org_id, s.key_encrypted, s.value_encrypted, s.note_encrypted, ' +
        's.created_at, s.revision_date, s.deleted_at ' +
        'FROM sm_secrets s JOIN sm_secret_projects sp ON sp.secret_id = s.id ' +
        'WHERE s.org_id = ? AND sp.project_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at'
    )
    .bind(orgId, projectId)
    .all<any>();
  return (result.results ?? []).map(mapSecretRow);
}

export async function getSecretById(db: D1Database, orgId: string, id: string): Promise<SmSecret | null> {
  const row = await db
    .prepare(`SELECT ${SECRET_COLUMNS} FROM sm_secrets WHERE org_id = ? AND id = ?`)
    .bind(orgId, id)
    .first<any>();
  return row ? mapSecretRow(row) : null;
}

export async function createSecret(db: D1Database, secret: SmSecret): Promise<void> {
  await db
    .prepare(
      'INSERT INTO sm_secrets(id, org_id, key_encrypted, value_encrypted, note_encrypted, created_at, revision_date, deleted_at) ' +
        'VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      secret.id,
      secret.orgId,
      secret.keyEncrypted,
      secret.valueEncrypted,
      secret.noteEncrypted,
      secret.createdAt,
      secret.revisionDate,
      secret.deletedAt
    )
    .run();
}

export async function updateSecret(
  db: D1Database,
  secret: Pick<SmSecret, 'orgId' | 'id' | 'keyEncrypted' | 'valueEncrypted' | 'noteEncrypted' | 'revisionDate'>
): Promise<void> {
  await db
    .prepare(
      'UPDATE sm_secrets SET key_encrypted = ?, value_encrypted = ?, note_encrypted = ?, revision_date = ? ' +
        'WHERE org_id = ? AND id = ? AND deleted_at IS NULL'
    )
    .bind(
      secret.keyEncrypted,
      secret.valueEncrypted,
      secret.noteEncrypted,
      secret.revisionDate,
      secret.orgId,
      secret.id
    )
    .run();
}

/** 软删（进 Trash）。已经删过的不重复写，保留首次删除时间。 */
export async function softDeleteSecrets(
  db: D1Database,
  orgId: string,
  ids: readonly string[],
  deletedAt: string
): Promise<void> {
  for (const id of ids) {
    await db
      .prepare('UPDATE sm_secrets SET deleted_at = ? WHERE org_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(deletedAt, orgId, id)
      .run();
  }
}

/**
 * 物理清除 `deleted_at` 早于 `cutoff` 的 secret（Trash 满期），返回清除条数。
 *
 * ⚠️ 不需要 `deleted_at IS NOT NULL`（`NULL < ?` 不成立）；关联表都挂 `ON DELETE CASCADE`，
 * 删本体即可。
 */
export async function purgeExpiredSecrets(db: D1Database, cutoff: string): Promise<number> {
  const result = await db.prepare('DELETE FROM sm_secrets WHERE deleted_at < ?').bind(cutoff).run();
  return Number(result.meta.changes ?? 0);
}

/** 取回收站里的单条（**只**认 `deleted_at IS NOT NULL`，否则就不是回收站的内容）。 */
export async function getTrashedSecret(db: D1Database, orgId: string, id: string): Promise<SmSecret | null> {
  const row = await db
    .prepare(`SELECT ${SECRET_COLUMNS} FROM sm_secrets WHERE org_id = ? AND id = ? AND deleted_at IS NOT NULL`)
    .bind(orgId, id)
    .first<any>();
  return row ? mapSecretRow(row) : null;
}

/**
 * 物理删除指定的、**仍在 Trash 里**的 secret（永久删除），返回真的删掉的 id。
 *
 * ⚠️ 仅限 `deleted_at IS NOT NULL`：还没进 Trash 的不该被这条路绕过软删直接抹掉。
 * 关联表（`sm_secret_projects` / `sm_secret_access`）都挂 `ON DELETE CASCADE`，删本体即可。
 */
export async function purgeSecretsByIds(db: D1Database, orgId: string, ids: readonly string[]): Promise<string[]> {
  const purged: string[] = [];
  for (const id of ids) {
    const result = await db
      .prepare('DELETE FROM sm_secrets WHERE org_id = ? AND id = ? AND deleted_at IS NOT NULL')
      .bind(orgId, id)
      .run();
    if (Number(result.meta.changes ?? 0) > 0) purged.push(id);
  }
  return purged;
}

/** 列出组织内**在 Trash 里**的 secret（最近删除的在前）。 */
export async function listTrashedSecrets(db: D1Database, orgId: string): Promise<SmSecret[]> {
  const result = await db
    .prepare(
      `SELECT ${SECRET_COLUMNS} FROM sm_secrets WHERE org_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    )
    .bind(orgId)
    .all<any>();
  return (result.results ?? []).map(mapSecretRow);
}

/** 撤销软删（Trash → 正常）。只对**确实在 Trash 里**的那一行生效；返回是否改了。 */
export async function restoreSecret(db: D1Database, orgId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE sm_secrets SET deleted_at = NULL WHERE org_id = ? AND id = ? AND deleted_at IS NOT NULL')
    .bind(orgId, id)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

/**
 * secret → project 关联，返回 `secretId → projectId[]`。
 *
 * 一次查齐全组织的关联（避免按 secret 逐个查的 N+1）：当前规模下一条查询就够。
 */
export async function listSecretProjectIds(db: D1Database, orgId: string): Promise<Map<string, string[]>> {
  const result = await db
    .prepare(
      'SELECT sp.secret_id, sp.project_id FROM sm_secret_projects sp ' +
        'JOIN sm_secrets s ON s.id = sp.secret_id WHERE s.org_id = ? ' +
        'ORDER BY sp.secret_id, sp.project_id'
    )
    .bind(orgId)
    .all<any>();

  const grouped = new Map<string, string[]>();
  for (const row of result.results ?? []) {
    const list = grouped.get(row.secret_id) ?? [];
    list.push(row.project_id);
    grouped.set(row.secret_id, list);
  }
  return grouped;
}

/** 整体替换某个 secret 的 project 集合（先清后插，避免残留旧关联）。 */
export async function setSecretProjects(db: D1Database, secretId: string, projectIds: readonly string[]): Promise<void> {
  await db.prepare('DELETE FROM sm_secret_projects WHERE secret_id = ?').bind(secretId).run();
  for (const projectId of projectIds) {
    await db
      .prepare('INSERT OR IGNORE INTO sm_secret_projects(secret_id, project_id) VALUES(?, ?)')
      .bind(secretId, projectId)
      .run();
  }
}

/** 增量同步：`revision_date` 严格晚于给定时刻的 secret（含软删的，供客户端对账）。 */
export async function listSecretsChangedSince(db: D1Database, orgId: string, since: string): Promise<SmSecret[]> {
  const result = await db
    .prepare(`SELECT ${SECRET_COLUMNS} FROM sm_secrets WHERE org_id = ? AND revision_date > ? ORDER BY revision_date`)
    .bind(orgId, since)
    .all<any>();
  return (result.results ?? []).map(mapSecretRow);
}

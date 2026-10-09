import { generateUUID } from '../utils/uuid';

/**
 * 机密管理器的存储层。
 *
 * **隐式组织**：每个用户恰好一个（`owner_user_id` UNIQUE），只为满足「SM 是组织级产品」
 * 的契约形态 —— 组织 id 要进 JWT 与 URL 路径。组织不暴露成员概念：owner 就是唯一成员。
 * 组织密钥由**用户的密码库密钥**包裹后存 `sm_org_keys`，服务端不接触明文。
 *
 * 组织不暴露成员概念：owner 就是唯一成员。
 */

export interface SmOrganization {
  id: string;
  ownerUserId: string;
  createdAt: string;
}

/** 组织密钥的用户侧包裹：`wrappedOrgKey` 是 EncString type 2，客户端解开后才能解密机密。 */
export interface SmOrgKey {
  orgId: string;
  userId: string;
  wrappedOrgKey: string;
  createdAt: string;
}

function mapOrganizationRow(row: any): SmOrganization {
  return { id: row.id, ownerUserId: row.owner_user_id, createdAt: row.created_at };
}

function mapOrgKeyRow(row: any): SmOrgKey {
  return { orgId: row.org_id, userId: row.user_id, wrappedOrgKey: row.wrapped_org_key, createdAt: row.created_at };
}

export async function getImplicitOrganization(db: D1Database, userId: string): Promise<SmOrganization | null> {
  const row = await db
    .prepare('SELECT id, owner_user_id, created_at FROM sm_organizations WHERE owner_user_id = ?')
    .bind(userId)
    .first<any>();
  return row ? mapOrganizationRow(row) : null;
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

export async function getOrgKey(db: D1Database, orgId: string, userId: string): Promise<SmOrgKey | null> {
  const row = await db
    .prepare('SELECT org_id, user_id, wrapped_org_key, created_at FROM sm_org_keys WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId)
    .first<any>();
  return row ? mapOrgKeyRow(row) : null;
}

/** 写入组织密钥包裹。重复写入视为「换成新密钥」：只覆盖密文，`created_at` 保持首次时间。 */
export async function saveOrgKey(
  db: D1Database,
  orgId: string,
  userId: string,
  wrappedOrgKey: string
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO sm_org_keys(org_id, user_id, wrapped_org_key, created_at) VALUES(?, ?, ?, ?) ' +
      'ON CONFLICT(org_id, user_id) DO UPDATE SET wrapped_org_key = excluded.wrapped_org_key'
    )
    .bind(orgId, userId, wrappedOrgKey, new Date().toISOString())
    .run();
}

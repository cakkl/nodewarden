/**
 * 机密管理器访问令牌的存储层。
 *
 * **安全不变量**：库里只有 `secret_hash`（`SHA-256(client_secret)`），明文密钥只在创建
 * 令牌的那一次响应里出现过，服务端此后无法还原它 —— 这是「程序取用无需人工参与」的前提。
 */

export interface SmAccessToken {
  id: string;
  machineAccountId: string;
  orgId: string;
  name: string;
  secretHash: string;
  encryptedPayload: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function mapAccessTokenRow(row: any): SmAccessToken {
  return {
    id: row.id,
    machineAccountId: row.machine_account_id,
    orgId: row.org_id,
    name: row.name,
    secretHash: row.secret_hash,
    encryptedPayload: row.encrypted_payload,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/**
 * 按令牌 id 取令牌（请求里的 `client_id` 就是它，走主键）。
 *
 * ⚠️ **故意不过滤 `revoked_at` / `expires_at`**：调用方需要区分「不存在」「已吊销」「已过期」
 * 以便写审计事件，而 SQL 里过滤会把三者压成同一个「查不到」。调用方在签发前**必须**自行
 * 检查这两个字段（对外的错误码则应统一，不要泄露是哪一种）。
 *
 * ⚠️ 拿到行之后**必须**用 `verifyApiKey(clientSecret, row.secretHash)` 比对密钥（常量时间），
 * 不要自己写字符串相等比较。
 */
export async function getAccessTokenById(db: D1Database, tokenId: string): Promise<SmAccessToken | null> {
  const row = await db
    .prepare(
      'SELECT id, machine_account_id, org_id, name, secret_hash, encrypted_payload, ' +
        'expires_at, revoked_at, last_used_at, created_at ' +
        'FROM sm_access_tokens WHERE id = ?'
    )
    .bind(tokenId)
    .first<any>();
  return row ? mapAccessTokenRow(row) : null;
}

/** 记一次使用时间。失败不应中断鉴权流程（调用方自行吞掉异常）。 */
export async function touchAccessTokenLastUsed(db: D1Database, tokenId: string, lastUsedAt: string): Promise<void> {
  await db.prepare('UPDATE sm_access_tokens SET last_used_at = ? WHERE id = ?').bind(lastUsedAt, tokenId).run();
}

/** 吊销令牌。按 `(id, org_id)` 限定，避免跨组织吊销。 */
export async function revokeAccessToken(db: D1Database, tokenId: string, orgId: string, revokedAt: string): Promise<void> {
  await db
    .prepare('UPDATE sm_access_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL')
    .bind(revokedAt, tokenId, orgId)
    .run();
}

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

/** 令牌表的列清单（读写两处都要用；列顺序与 `mapAccessTokenRow` 一致）。 */
const TOKEN_COLUMNS =
  'id, machine_account_id, org_id, name, secret_hash, encrypted_payload, expires_at, revoked_at, last_used_at, created_at';

/** D1 单条语句的绑定参数上限（`StorageService.MAX_D1_SQL_VARIABLES` 也是这个值）。 */
const MAX_BIND_PARAMS = 100;

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
 * ⚠️ **故意不过滤 `revoked_at` / `expires_at`**：调用方要区分「不存在」「已吊销」「已过期」，
 * SQL 里过滤会把三者压成同一个「查不到」。调用方在签发前**必须**自行检查这两列。
 *
 * ⚠️ 拿到行之后**必须**用 `verifyApiKey(clientSecret, row.secretHash)` 比对密钥（常量时间）。
 */
export async function getAccessTokenById(db: D1Database, tokenId: string): Promise<SmAccessToken | null> {
  const row = await db
    .prepare(`SELECT ${TOKEN_COLUMNS} FROM sm_access_tokens WHERE id = ?`)
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

/**
 * 一次取多个机器账号名下的令牌（`账号 id → 令牌`），避免列表页按账号各查一遍。
 * `IN (...)` 按 D1 参数上限分块；每个账号只落在一块里 ⇒ 块内的 `created_at` 序与单账号端点一致。
 */
export async function listAccessTokensByMachineAccounts(
  db: D1Database,
  machineAccountIds: readonly string[]
): Promise<Map<string, SmAccessToken[]>> {
  const grouped = new Map<string, SmAccessToken[]>();
  const ids = [...new Set(machineAccountIds.filter((id): id is string => !!id))];
  for (let start = 0; start < ids.length; start += MAX_BIND_PARAMS) {
    const chunk = ids.slice(start, start + MAX_BIND_PARAMS);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT ${TOKEN_COLUMNS} FROM sm_access_tokens WHERE machine_account_id IN (${placeholders}) ORDER BY created_at`
      )
      .bind(...chunk)
      .all<any>();
    for (const row of result.results ?? []) {
      const token = mapAccessTokenRow(row);
      const list = grouped.get(token.machineAccountId) ?? [];
      list.push(token);
      grouped.set(token.machineAccountId, list);
    }
  }
  return grouped;
}

/** 列出某个机器账号名下的令牌（Web UI 用）。 */
export async function listAccessTokensByMachineAccount(
  db: D1Database,
  machineAccountId: string
): Promise<SmAccessToken[]> {
  const result = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS} FROM sm_access_tokens WHERE machine_account_id = ? ORDER BY created_at`
    )
    .bind(machineAccountId)
    .all<any>();
  return (result.results ?? []).map(mapAccessTokenRow);
}

/**
 * 创建令牌。
 *
 * ⚠️ `secretHash` 来自**客户端**（它自己算 `SHA-256(client_secret)`）—— 明文密钥不进服务端，
 * 换来的是「库被读走也无法用它登录」（哈希不可逆）。格式必须与 `verifyApiKey` 认的一致。
 */
export async function createAccessToken(db: D1Database, token: SmAccessToken): Promise<void> {
  await db
    .prepare(
      'INSERT INTO sm_access_tokens(id, machine_account_id, org_id, name, secret_hash, encrypted_payload, ' +
        'expires_at, revoked_at, last_used_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      token.id,
      token.machineAccountId,
      token.orgId,
      token.name,
      token.secretHash,
      token.encryptedPayload,
      token.expiresAt,
      token.revokedAt,
      token.lastUsedAt,
      token.createdAt
    )
    .run();
}

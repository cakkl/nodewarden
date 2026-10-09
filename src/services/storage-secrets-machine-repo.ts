/**
 * 机器账号与「机器账号 × project」授权的存储层。
 *
 * 权限只有两档（`read` / `write`），作用在 project 上 —— 这是程序侧唯一的权限来源，
 * secret 级的直接授权另见 `sm_secret_access`。机器账号名是明文（官方同款）。
 */

/** 两档权限，与官方的「Can read」/「Can read, write」一一对应。 */
export type SmPermission = 'read' | 'write';

export interface SmMachineAccount {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
  /** 名称 / 项目授权的最后变更时间（令牌不算）。 */
  revisionDate: string;
}

export interface SmMachineAccountGrant {
  machineAccountId: string;
  projectId: string;
  permission: SmPermission;
}

function mapMachineAccountRow(row: any): SmMachineAccount {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    createdAt: row.created_at,
    // 补列前写入的行 `revision_date` 为 NULL ⇒ 退回 created_at（详情卡片始终有值）
    revisionDate: row.revision_date ?? row.created_at,
  };
}

function mapGrantRow(row: any): SmMachineAccountGrant {
  return {
    machineAccountId: row.machine_account_id,
    projectId: row.project_id,
    permission: row.permission as SmPermission,
  };
}

export async function listMachineAccounts(db: D1Database, orgId: string): Promise<SmMachineAccount[]> {
  const result = await db
    .prepare('SELECT id, org_id, name, created_at, revision_date FROM sm_machine_accounts WHERE org_id = ? ORDER BY created_at')
    .bind(orgId)
    .all<any>();
  return (result.results ?? []).map(mapMachineAccountRow);
}

export async function getMachineAccount(db: D1Database, orgId: string, id: string): Promise<SmMachineAccount | null> {
  const row = await db
    .prepare('SELECT id, org_id, name, created_at, revision_date FROM sm_machine_accounts WHERE org_id = ? AND id = ?')
    .bind(orgId, id)
    .first<any>();
  return row ? mapMachineAccountRow(row) : null;
}

export async function createMachineAccount(db: D1Database, account: SmMachineAccount): Promise<void> {
  await db
    .prepare('INSERT INTO sm_machine_accounts(id, org_id, name, created_at, revision_date) VALUES(?, ?, ?, ?, ?)')
    .bind(account.id, account.orgId, account.name, account.createdAt, account.createdAt)
    .run();
}

/** 改名，并记下这次变更时间。名字是明文（与官方一致），授权与令牌不受影响。 */
export async function renameMachineAccount(db: D1Database, orgId: string, id: string, name: string): Promise<void> {
  await db
    .prepare('UPDATE sm_machine_accounts SET name = ?, revision_date = ? WHERE org_id = ? AND id = ?')
    .bind(name, new Date().toISOString(), orgId, id)
    .run();
}

/** 记下账号自身的最后变更时间（名称 / 项目授权的改动都算，令牌另行管理）。 */
async function touchMachineAccount(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('UPDATE sm_machine_accounts SET revision_date = ? WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run();
}

/**
 * 删除机器账号。授权与它名下的访问令牌靠外键 `ON DELETE CASCADE` 一并清掉
 * —— 不要在这里手写删除，漏一张表就会留下能用的凭据。
 */
export async function deleteMachineAccount(db: D1Database, orgId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM sm_machine_accounts WHERE org_id = ? AND id = ?').bind(orgId, id).run();
}

export async function listMachineAccountGrants(
  db: D1Database,
  machineAccountId: string
): Promise<SmMachineAccountGrant[]> {
  const result = await db
    .prepare(
      'SELECT machine_account_id, project_id, permission FROM sm_machine_account_projects ' +
        'WHERE machine_account_id = ?'
    )
    .bind(machineAccountId)
    .all<any>();
  return (result.results ?? []).map(mapGrantRow);
}

/** 授权/改档。同一 (账号, project) 只有一行，重复设置视为改档。 */
export async function setMachineAccountGrant(
  db: D1Database,
  machineAccountId: string,
  projectId: string,
  permission: SmPermission
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO sm_machine_account_projects(machine_account_id, project_id, permission) VALUES(?, ?, ?) ' +
        'ON CONFLICT(machine_account_id, project_id) DO UPDATE SET permission = excluded.permission'
    )
    .bind(machineAccountId, projectId, permission)
    .run();
  await touchMachineAccount(db, machineAccountId);
}

export async function removeMachineAccountGrant(
  db: D1Database,
  machineAccountId: string,
  projectId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM sm_machine_account_projects WHERE machine_account_id = ? AND project_id = ?')
    .bind(machineAccountId, projectId)
    .run();
  await touchMachineAccount(db, machineAccountId);
}

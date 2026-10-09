/**
 * 机密管理器 project 的存储层。
 *
 * 目前只有「按组织取单个」——授权路径需要它来确认 project 属于**本组织**（否则外键会以
 * 500 的形式炸出来，且等于允许引用别人的项目）。project 的增删改随 CRUD 那一步补齐。
 */

export interface SmProject {
  id: string;
  orgId: string;
  nameEncrypted: string;
  createdAt: string;
  revisionDate: string;
}

function mapProjectRow(row: any): SmProject {
  return {
    id: row.id,
    orgId: row.org_id,
    nameEncrypted: row.name_encrypted,
    createdAt: row.created_at,
    revisionDate: row.revision_date,
  };
}

export async function getProject(db: D1Database, orgId: string, id: string): Promise<SmProject | null> {
  const row = await db
    .prepare(
      'SELECT id, org_id, name_encrypted, created_at, revision_date FROM sm_projects WHERE org_id = ? AND id = ?'
    )
    .bind(orgId, id)
    .first<any>();
  return row ? mapProjectRow(row) : null;
}

export async function listProjects(db: D1Database, orgId: string): Promise<SmProject[]> {
  const result = await db
    .prepare(
      'SELECT id, org_id, name_encrypted, created_at, revision_date FROM sm_projects WHERE org_id = ? ORDER BY created_at'
    )
    .bind(orgId)
    .all<any>();
  return (result.results ?? []).map(mapProjectRow);
}

export async function createProject(db: D1Database, project: SmProject): Promise<void> {
  await db
    .prepare('INSERT INTO sm_projects(id, org_id, name_encrypted, created_at, revision_date) VALUES(?, ?, ?, ?, ?)')
    .bind(project.id, project.orgId, project.nameEncrypted, project.createdAt, project.revisionDate)
    .run();
}

/** 改名。`revision_date` 必须一起推，客户端靠它做增量同步。 */
export async function updateProjectName(
  db: D1Database,
  orgId: string,
  id: string,
  nameEncrypted: string,
  revisionDate: string
): Promise<void> {
  await db
    .prepare('UPDATE sm_projects SET name_encrypted = ?, revision_date = ? WHERE org_id = ? AND id = ?')
    .bind(nameEncrypted, revisionDate, orgId, id)
    .run();
}

/**
 * 硬删 project（照官方）。它名下的 secret **不删**：关联表 sm_secret_projects 的行级联删掉，
 * 于是那些 secret 变成「未分配」。
 */
export async function deleteProject(db: D1Database, orgId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM sm_projects WHERE org_id = ? AND id = ?').bind(orgId, id).run();
}

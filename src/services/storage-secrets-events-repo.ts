/**
 * 机密管理器事件（审计）的存储层。
 *
 * ⚠️ 三处「谁 / 什么 / 属于谁」不要混：
 * - `actor_type` / `actor_id` = **谁**干的（用户会话 or 机器账号令牌）
 * - `secret_id` / `project_id` = 事件作用在**什么**上
 * - `machine_account_id` = 事件**属于**哪个机器账号；机器账号自己操作时与 actor 相同，
 *   用户对该账号的操作（建 / 删）则只有这一列有值 —— 详情页的「事件日志」就按它取
 */

export type SmEventActorType = 'user' | 'machine_account';

export interface SmEvent {
  id: string;
  orgId: string;
  actorType: SmEventActorType;
  actorId: string;
  typeCode: number;
  secretId?: string | null;
  projectId?: string | null;
  machineAccountId?: string | null;
  ip?: string | null;
  createdAt: string;
}

/** 列表行：目标对象还在时附带它的**密文**名称（明文只在客户端解）。 */
export interface SmEventRow {
  id: string;
  actorType: SmEventActorType;
  typeCode: number;
  secretId: string | null;
  secretKeyEncrypted: string | null;
  projectId: string | null;
  projectNameEncrypted: string | null;
  createdAt: string;
}

/**
 * 逐条写入（官方口径：一批操作产生一批记录，批删 500 条就是 500 行）。
 * 走 `batch`：事务 + 一次往返，避免批量端点上打出几百次串行写入。
 */
export async function insertEvents(db: D1Database, events: readonly SmEvent[]): Promise<void> {
  if (events.length === 0) return;

  const statement = db.prepare(
    'INSERT INTO sm_events(id, org_id, actor_type, actor_id, type_code, secret_id, project_id, machine_account_id, ip, created_at) ' +
      'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  await db.batch(
    events.map((event) =>
      statement.bind(
        event.id,
        event.orgId,
        event.actorType,
        event.actorId,
        event.typeCode,
        event.secretId ?? null,
        event.projectId ?? null,
        event.machineAccountId ?? null,
        event.ip ?? null,
        event.createdAt
      )
    )
  );
}

/**
 * 某机器账号的事件日志（时间倒序，键集分页）。
 *
 * ⚠️ 游标必须是 `(created_at, id)` **复合**的：一次批量操作里所有事件共用同一个
 * `created_at`（见 `secrets-events.ts`），只用 `created_at < ?` 会在页边界把同毫秒剩下的
 * 记录整批丢掉 —— 而批量操作正是审计最需要看全的场景。两者必须同时给。
 *
 * ⚠️ 名称走 LEFT JOIN 取密文：机密 / 项目可能已被永久删除，那时名称一栏为 `null`，
 * 事件本身仍要照常显示。
 */
export async function listEventsByMachineAccount(
  db: D1Database,
  orgId: string,
  machineAccountId: string,
  limit: number,
  before?: string,
  beforeId?: string
): Promise<SmEventRow[]> {
  const useCursor = !!before && !!beforeId;
  const beforeClause = useCursor ? 'AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))' : '';
  const bindings: Array<string | number> = useCursor
    ? [orgId, machineAccountId, before, before, beforeId, limit]
    : [orgId, machineAccountId, limit];

  const result = await db
    .prepare(
      'SELECT e.id, e.actor_type, e.type_code, e.secret_id, e.project_id, e.created_at, ' +
        's.key_encrypted AS secret_key, p.name_encrypted AS project_name ' +
        'FROM sm_events e ' +
        'LEFT JOIN sm_secrets s ON s.id = e.secret_id ' +
        'LEFT JOIN sm_projects p ON p.id = e.project_id ' +
        `WHERE e.org_id = ? AND e.machine_account_id = ? ${beforeClause} ` +
        'ORDER BY e.created_at DESC, e.id DESC LIMIT ?'
    )
    .bind(...bindings)
    .all<any>();

  return (result.results ?? []).map((row: any): SmEventRow => ({
    id: row.id,
    actorType: row.actor_type,
    typeCode: row.type_code,
    secretId: row.secret_id ?? null,
    secretKeyEncrypted: row.secret_key ?? null,
    projectId: row.project_id ?? null,
    projectNameEncrypted: row.project_name ?? null,
    createdAt: row.created_at,
  }));
}

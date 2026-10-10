import type { Env, User } from '../types';
import { KV_MAX_OBJECT_BYTES, deleteBlobObject, getAttachmentObjectKey, getBlobObject, getBlobStorageKind, putBlobObject } from './blob-store';
import { BACKUP_SETTINGS_CONFIG_KEY, normalizeImportedBackupSettingsValue } from './backup-config';
import { reportProgress } from './backup-progress';
import { YUBICO_BOOTSTRAP_CLAIM_CONFIG_KEY } from './yubico-config';
import {
  type BackupManifestAttachmentBlob,
  type BackupPayload,
  isSafeBackupAttachmentBlobName,
  parseBackupArchive,
  validateBackupPayloadContents,
} from './backup-archive';

// CONTRACT:
// Restore is intentionally whitelist-based. Old backups may contain retired
// fields, but only the columns listed here are imported. Keep this file in sync
// with src/services/backup-archive.ts whenever backup contents change.
//
// WHEN CHANGING THIS:
// - Update BackupTableName, BACKUP_TABLES, reset statements, prepared payloads,
//   shadow-table count validation, insert column lists, and frontend import
//   count types together.
// - Do not import users.api_key, even if an older backup contains it.
// - Do not import, clear, or replace runtime authentication state such as
//   devices, sessions, auth requests, or remembered 2FA device tokens.
// - The Secrets Manager audit trail (sm_events) stays out, like audit_logs;
//   everything else under sm_* is part of the instance and is replaced.
type SqlRow = Record<string, string | number | null>;
type BackupTableName =
  | 'config'
  | 'users'
  | 'domain_settings'
  | 'user_revisions'
  | 'webauthn_credentials'
  | 'folders'
  | 'ciphers'
  | 'attachments'
  | 'sm_organizations'
  | 'sm_org_keys'
  | 'sm_projects'
  | 'sm_machine_accounts'
  | 'sm_secrets'
  | 'sm_secret_projects'
  | 'sm_machine_account_projects'
  | 'sm_access_tokens';

/** 机密管理器在备份里的表（外键序，父在前）。`sm_events` 是审计流水，与 `audit_logs` 一样不进备份。
 *  导出给护栏测试：新增 `sm_*` 表时必须有意识地决定要不要进备份。 */
export const SECRETS_MANAGER_BACKUP_TABLES = [
  'sm_organizations',
  'sm_org_keys',
  'sm_projects',
  'sm_machine_accounts',
  'sm_secrets',
  'sm_secret_projects',
  'sm_machine_account_projects',
  'sm_access_tokens',
] as const satisfies readonly BackupTableName[];

const BACKUP_TABLES: BackupTableName[] = [
  'config',
  'users',
  'domain_settings',
  'user_revisions',
  'webauthn_credentials',
  'folders',
  'ciphers',
  'attachments',
  ...SECRETS_MANAGER_BACKUP_TABLES,
];

function shadowTableName(table: BackupTableName): string {
  return `${table}__restore`;
}

export interface BackupImportResultBody {
  object: 'instance-backup-import';
  imported: {
    config: number;
    users: number;
    domainSettings: number;
    userRevisions: number;
    webauthnCredentials: number;
    folders: number;
    ciphers: number;
    attachments: number;
    attachmentFiles: number;
    /** 机密管理器：只报用户看得懂的四项（关联表行数不单报）。 */
    smProjects: number;
    smSecrets: number;
    smMachineAccounts: number;
    smAccessTokens: number;
  };
  skipped: {
    reason: string | null;
    attachments: number;
    items: Array<{
      kind: 'attachment';
      path: string;
      sizeBytes: number;
    }>;
  };
}

export interface BackupImportExecutionResult {
  result: BackupImportResultBody;
  auditActorUserId: string | null;
}

async function queryRows(db: D1Database, sql: string, ...values: unknown[]): Promise<SqlRow[]> {
  const response = await db.prepare(sql).bind(...values).all<SqlRow>();
  return (response.results || []).map((row) => ({ ...row }));
}

async function getTableCreateSql(db: D1Database, table: BackupTableName): Promise<string> {
  const row = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(table)
    .first<{ sql: string | null }>();
  const sql = String(row?.sql || '').trim();
  if (!sql) {
    throw new Error(`Restore shadow schema is missing table definition for ${table}`);
  }
  return sql;
}

function buildShadowTableCreateSql(createSql: string, table: BackupTableName): string {
  const tablePattern = new RegExp(`^CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+(?:\"${table}\"|${table})(?=\\s*\\()`, 'i');
  let next = createSql.replace(tablePattern, `CREATE TABLE "${shadowTableName(table)}"`);
  if (next === createSql) {
    throw new Error(`Restore shadow schema could not rewrite CREATE TABLE statement for ${table}`);
  }
  for (const currentTable of BACKUP_TABLES) {
    const referencePattern = new RegExp(`\\bREFERENCES\\s+(?:\"${currentTable}\"|${currentTable})(?=\\s*\\()`, 'gi');
    next = next.replace(
      referencePattern,
      `REFERENCES "${shadowTableName(currentTable)}"`
    );
  }
  return next;
}

async function resetRestoreArtifacts(db: D1Database): Promise<void> {
  const dropStatements = BACKUP_TABLES
    .slice()
    .reverse()
    .map((table) => db.prepare(`DROP TABLE IF EXISTS ${shadowTableName(table)}`));
  if (dropStatements.length) {
    await db.batch(dropStatements);
  }
}

async function createShadowTables(db: D1Database): Promise<void> {
  const createStatements: D1PreparedStatement[] = [];
  for (const table of BACKUP_TABLES) {
    const createSql = await getTableCreateSql(db, table);
    createStatements.push(db.prepare(buildShadowTableCreateSql(createSql, table)));
  }
  await db.batch(createStatements);
}

async function validateShadowTableCounts(
  db: D1Database,
  expectedCounts: Partial<Record<BackupTableName, number>>
): Promise<void> {
  await Promise.all(BACKUP_TABLES.map(async (table) => {
    const expected = expectedCounts[table] ?? 0;
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${shadowTableName(table)}`).first<{ count: number }>();
    const actual = Number(row?.count || 0);
    if (actual !== expected) {
      throw new Error(`Restore shadow validation failed for ${table}: expected ${expected}, received ${actual}`);
    }
  }));
}

/** 影子表写入后要逐表核对行数：期望值就是归档里各表的行数（附件另算，失败项会被剔除）。 */
function expectedShadowCounts(
  db: BackupPayload['db'],
  attachments: number
): Partial<Record<BackupTableName, number>> {
  const counts: Partial<Record<BackupTableName, number>> = {
    config: (db.config || []).length,
    users: (db.users || []).length,
    domain_settings: (db.domain_settings || []).length,
    user_revisions: (db.user_revisions || []).length,
    webauthn_credentials: (db.webauthn_credentials || []).length,
    folders: (db.folders || []).length,
    ciphers: (db.ciphers || []).length,
    attachments,
  };
  const tables = db as unknown as Record<string, SqlRow[] | undefined>;
  for (const table of SECRETS_MANAGER_BACKUP_TABLES) {
    counts[table] = (tables[table] || []).length;
  }
  return counts;
}

async function swapShadowTablesIntoPlace(db: D1Database): Promise<void> {
  // 一整批提交：换库前活库不动，最后一批同时清空 + 写回；中途失败则活库原样保留。
  const statements: D1PreparedStatement[] = [
    ...buildResetImportTargetStatements(db),
    ...BACKUP_TABLES.map((table) => db.prepare(`INSERT INTO ${table} SELECT * FROM ${shadowTableName(table)}`)),
  ];
  await db.batch(statements);
}

async function ensureImportTargetIsFresh(db: D1Database): Promise<void> {
  const counts = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM ciphers').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM folders').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM attachments').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM sends').first<{ count: number }>(),
    // 机密管理器现在也参与备份 ⇒ 它的数据同样会被覆盖，必须同样纳入「实例非空」判定。
    // 组织行只在真正写过组织密钥（即用过机密管理器）时才存在，适合当探针。
    db.prepare('SELECT COUNT(*) AS count FROM sm_organizations').first<{ count: number }>(),
  ]);
  const total = counts.reduce((sum, row) => sum + Number(row?.count || 0), 0);
  if (total > 0) {
    throw new Error('Backup import requires a fresh instance with no vault or send data');
  }
}

function buildResetImportTargetStatements(db: D1Database): D1PreparedStatement[] {
  return [
    // ⚠️ `sm_events` 不在备份里，但必须一起清：它是「换库」那把 `DELETE FROM users` 的**级联**产物，
    // 一旦实例没开外键约束就会留下指向已删组织的悬空行。
    'DELETE FROM sm_events',
    'DELETE FROM sm_secret_projects',
    'DELETE FROM sm_machine_account_projects',
    'DELETE FROM sm_access_tokens',
    'DELETE FROM sm_secrets',
    'DELETE FROM sm_projects',
    'DELETE FROM sm_org_keys',
    'DELETE FROM sm_machine_accounts',
    'DELETE FROM sm_organizations',
    'DELETE FROM attachments',
    'DELETE FROM ciphers',
    'DELETE FROM folders',
    'DELETE FROM webauthn_credentials',
    'DELETE FROM domain_settings',
    'DELETE FROM user_revisions',
    'DELETE FROM users',
    'DELETE FROM config',
  ].map((sql) => db.prepare(sql));
}

async function collectCurrentBlobKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  const attachmentRows = await queryRows(
    db,
    `SELECT a.id, a.cipher_id
     FROM attachments a
     INNER JOIN ciphers c ON c.id = a.cipher_id`
  );
  for (const row of attachmentRows) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    keys.add(getAttachmentObjectKey(cipherId, attachmentId));
  }
  return keys;
}

const KV_BLOB_SKIP_REASON = 'Cloudflare KV object size limit (25 MB)';
const BLOB_STORAGE_UNAVAILABLE_SKIP_REASON = 'Attachment storage is not configured';
const ATTACHMENT_RESTORE_FAILED_REASON = 'Some attachments could not be restored and were skipped';

interface BackupImportSkipSummary {
  reason: string | null;
  attachments: number;
  items: Array<{
    kind: 'attachment';
    path: string;
    sizeBytes: number;
  }>;
}

interface PreparedBackupImportPayload {
  payload: BackupPayload;
  skipped: BackupImportSkipSummary;
}

interface AttachmentRestoreResult {
  imported: number;
  restoredAttachments: SqlRow[];
  skipped: BackupImportSkipSummary;
}

interface RemoteAttachmentSource {
  loadAttachment(blobName: string): Promise<Uint8Array | null>;
}

export interface BackupRestoreProgressEvent {
  source: 'local' | 'remote';
  step: string;
  fileName: string;
  stageTitle: string;
  stageDetail: string;
  replaceExisting: boolean;
  done?: boolean;
  ok?: boolean;
  error?: string | null;
}

/**
 * 恢复进度回调。**必须**自行吞掉异常（`handlers/backup.ts` 的实现会先 `touchLease()`，那一步**会抛**）；
 * 即便如此，内部上报也必须走 `reportProgress()`，见 `services/backup-progress.ts` 的 CONTRACT —— 本文件
 * 所有调用点都遵守它。
 */
export type BackupRestoreProgressReporter = (event: BackupRestoreProgressEvent) => Promise<void> | void;

function attachmentRowKey(row: SqlRow): string {
  const attachmentId = String(row.id || '').trim();
  const cipherId = String(row.cipher_id || '').trim();
  return `${cipherId}/${attachmentId}`;
}

function cloneRows(rows: SqlRow[]): SqlRow[] {
  return rows.map((row) => ({ ...row }));
}

function normalizeAccountPasskeyPurpose(value: unknown): 'login' | 'twoFactor' {
  return value == null ? 'login' : String(value).trim() === 'twoFactor' ? 'twoFactor' : 'login';
}

function upsertConfigRow(rows: SqlRow[], key: string, value: string): SqlRow[] {
  let replaced = false;
  const nextRows = rows.map((row) => {
    if (String(row.key || '').trim() !== key) return { ...row };
    replaced = true;
    return { ...row, key, value };
  });
  if (!replaced) {
    nextRows.push({ key, value });
  }
  return nextRows;
}

async function prepareImportedConfigRows(
  env: Env,
  configRows: SqlRow[],
  userRows: SqlRow[]
): Promise<SqlRow[]> {
  let nextConfigRows = cloneRows(configRows || []).filter(
    (row) => String(row.key || '').trim() !== YUBICO_BOOTSTRAP_CLAIM_CONFIG_KEY
  );
  const rawBackupSettings = nextConfigRows.find((row) => String(row.key || '').trim() === BACKUP_SETTINGS_CONFIG_KEY);
  const normalizedBackupSettings = await normalizeImportedBackupSettingsValue(
    typeof rawBackupSettings?.value === 'string' ? rawBackupSettings.value : null,
    env,
    userRows.map((row) => ({
      id: String(row.id || '').trim(),
      publicKey: typeof row.public_key === 'string' ? row.public_key : null,
      role: String(row.role || '').trim() as User['role'],
      status: String(row.status || '').trim() as User['status'],
    })),
    'UTC'
  );
  if (normalizedBackupSettings !== null) {
    nextConfigRows = upsertConfigRow(nextConfigRows, BACKUP_SETTINGS_CONFIG_KEY, normalizedBackupSettings);
  }
  nextConfigRows = upsertConfigRow(nextConfigRows, 'registered', 'true');
  return nextConfigRows;
}

async function importPreparedBackupRows(db: D1Database, payload: BackupPayload['db'], env: Env): Promise<BackupPayload['db']> {
  // 就地补默认值（而不是像过去那样用 cloneRows 整表深拷贝）：解析出来的对象树是本次恢复
  // 独占的，复制一份只会让内存峰值翻倍；大库（1.6 万行级）最吃内存的就是这一段。
  payload.config = await prepareImportedConfigRows(env, payload.config || [], payload.users || []);
  for (const row of payload.users || []) {
    if (row.verify_devices == null) row.verify_devices = 0;
    if (row.yubikey_nfc == null) row.yubikey_nfc = 0;
    // 旧备份没有 email_verified 列，按未验证处理，避免恢复后凭空放行通知邮件。
    if (row.email_verified == null) row.email_verified = 0;
  }
  for (const row of payload.webauthn_credentials || []) {
    row.purpose = normalizeAccountPasskeyPurpose(row.purpose);
  }
  for (const row of payload.ciphers || []) {
    if (row.archived_at == null) row.archived_at = null;
  }
  await importBackupRows(db, payload, true);
  return payload;
}

function prepareImportPayloadForTarget(env: Env, payload: BackupPayload, files: Record<string, Uint8Array>): PreparedBackupImportPayload {
  const storageKind = getBlobStorageKind(env);
  if (storageKind === 'r2') {
    return {
      payload,
      skipped: {
        reason: null,
        attachments: 0,
        items: [],
      },
    };
  }

  if (storageKind === null) {
    const skippedItems = (payload.db.attachments || []).map((row) => {
      const cipherId = String(row.cipher_id || '').trim();
      const attachmentId = String(row.id || '').trim();
      return {
        kind: 'attachment' as const,
        path: `attachments/${cipherId}/${attachmentId}.bin`,
        sizeBytes: Number(row.size || 0) || 0,
      };
    });

    const result = {
      payload: {
        ...payload,
        db: {
          ...payload.db,
          attachments: [],
        },
      },
      skipped: {
        reason: skippedItems.length ? BLOB_STORAGE_UNAVAILABLE_SKIP_REASON : null,
        attachments: skippedItems.length,
        items: skippedItems,
      },
    };
    return result;
  }

  const oversizedAttachmentPaths = new Set<string>();
  const skippedItems: BackupImportSkipSummary['items'] = [];

  for (const entry of Object.keys(files)) {
    if (!entry.endsWith('.bin')) continue;
    const sizeBytes = files[entry].byteLength;
    if (sizeBytes <= KV_MAX_OBJECT_BYTES) continue;
    if (entry.startsWith('attachments/')) {
      oversizedAttachmentPaths.add(entry);
      skippedItems.push({ kind: 'attachment', path: entry, sizeBytes });
    }
  }

  const nextAttachments = (payload.db.attachments || []).filter((row) => {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) return false;
    return !oversizedAttachmentPaths.has(`attachments/${cipherId}/${attachmentId}.bin`);
  });

  const nextPayload: BackupPayload = {
    ...payload,
    db: {
      ...payload.db,
      attachments: nextAttachments,
    },
  };

  const needsKvBlobStorage = nextAttachments.length > 0;

  if (needsKvBlobStorage && !env.ATTACHMENTS_KV) {
    throw new Error('Backup restore requires ATTACHMENTS_KV when using KV blob storage');
  }

  const result = {
    payload: nextPayload,
    skipped: {
      reason: skippedItems.length ? KV_BLOB_SKIP_REASON : null,
      attachments: skippedItems.length,
      items: skippedItems,
    },
  };
  return result;
}

function buildInsertStatements(db: D1Database, table: string, columns: string[], rows: SqlRow[], upsert = false): D1PreparedStatement[] {
  if (!rows.length) return [];
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const sql = `INSERT ${upsert ? 'OR REPLACE ' : ''}INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
  return rows.map((row) => db.prepare(sql).bind(...columns.map((column) => row[column] ?? null)));
}

async function runInsertBatch(db: D1Database, table: string, statements: D1PreparedStatement[]): Promise<void> {
  if (!statements.length) return;
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Restore insert failed for ${table}: ${message}`);
  }
}

/**
 * 恢复写入的批大小。
 *
 * 过去是**整表一次** `db.batch()`：一个 3 万行的库里同一批会有 3 万条语句，内存峰值随库大小线性增长，
 * 也白白撞 D1 对单次 batch 规模的限制。分批后峰值只与批大小有关，与库大小无关。
 */
const RESTORE_INSERT_BATCH_SIZE = 200;

/** 逐批构造并提交插入语句 —— 不先把整表语句都建出来（那正是要避免的峰值）。 */
async function insertRows(
  db: D1Database,
  table: string,
  columns: string[],
  rows: SqlRow[],
  upsert = false
): Promise<void> {
  for (let start = 0; start < rows.length; start += RESTORE_INSERT_BATCH_SIZE) {
    const chunk = rows.slice(start, start + RESTORE_INSERT_BATCH_SIZE);
    await runInsertBatch(db, table, buildInsertStatements(db, table, columns, chunk, upsert));
  }
}

async function restoreBlobFiles(
  env: Env,
  db: BackupPayload['db'],
  files: Record<string, Uint8Array>,
  keepKeys: Set<string>
): Promise<AttachmentRestoreResult & { writtenKeys: string[]; overwritten: BlobRollbackStash }> {
  const restoredAttachments: SqlRow[] = [];
  const skippedItems: BackupImportSkipSummary['items'] = [];
  // 本次真正落盘的键。恢复失败时要靠它回退（DB 没换成功，这些对象必须清掉/还原）。
  const writtenKeys: string[] = [];
  // 被覆盖的活库附件原内容（仅在键与活库撞车时才会有）—— 失败时要放回去。
  const overwritten = createBlobRollbackStash();

  for (const row of db.attachments || []) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    const key = `attachments/${cipherId}/${attachmentId}.bin`;
    const bytes = files[key];
    if (!bytes) {
      skippedItems.push({
        kind: 'attachment',
        path: key,
        sizeBytes: Number(row.size || 0) || 0,
      });
      continue;
    }
    try {
      const objectKey = getAttachmentObjectKey(cipherId, attachmentId);
      await stashLiveBlobIfOverwriting(env, objectKey, keepKeys, overwritten);
      await putBlobObject(env, objectKey, bytes, {
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
      });
      writtenKeys.push(objectKey);
      restoredAttachments.push(row);
    } catch {
      skippedItems.push({
        kind: 'attachment',
        path: key,
        sizeBytes: bytes.byteLength,
      });
    }
  }

  return {
    imported: restoredAttachments.length,
    restoredAttachments,
    writtenKeys,
    overwritten,
    skipped: {
      reason: skippedItems.length ? ATTACHMENT_RESTORE_FAILED_REASON : null,
      attachments: skippedItems.length,
      items: skippedItems,
    },
  };
}

function buildAttachmentBlobLookup(manifest: BackupPayload['manifest']): Map<string, BackupManifestAttachmentBlob> {
  const lookup = new Map<string, BackupManifestAttachmentBlob>();
  for (const item of manifest.attachmentBlobs || []) {
    const cipherId = String(item.cipherId || '').trim();
    const attachmentId = String(item.attachmentId || '').trim();
    const blobName = String(item.blobName || '').trim();
    if (!cipherId || !attachmentId || !isSafeBackupAttachmentBlobName(blobName)) continue;
    lookup.set(`${cipherId}/${attachmentId}`, {
      ...item,
      cipherId,
      attachmentId,
      blobName,
    });
  }
  return lookup;
}

async function prepareRemoteAttachmentPayload(
  env: Env,
  payload: BackupPayload,
  files: Record<string, Uint8Array>,
  source: RemoteAttachmentSource
): Promise<PreparedBackupImportPayload> {
  const manifestLookup = buildAttachmentBlobLookup(payload.manifest);
  const storageKind = getBlobStorageKind(env);
  const nextAttachments: SqlRow[] = [];
  const skippedItems: BackupImportSkipSummary['items'] = [];

  for (const row of payload.db.attachments || []) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    const lookupKey = `${cipherId}/${attachmentId}`;
    const ref = manifestLookup.get(lookupKey);
    const sizeBytes = ref?.sizeBytes || Number(row.size || 0) || 0;
    const path = ref ? `attachments/${ref.blobName}` : `attachments/${lookupKey}`;
    const inlinePath = `attachments/${cipherId}/${attachmentId}.bin`;

    if (files[inlinePath]) {
      nextAttachments.push(row);
      continue;
    }
    if (!ref) {
      skippedItems.push({ kind: 'attachment', path, sizeBytes });
      continue;
    }
    if (storageKind === 'kv' && sizeBytes > KV_MAX_OBJECT_BYTES) {
      skippedItems.push({ kind: 'attachment', path, sizeBytes });
      continue;
    }
    if (storageKind === null) {
      skippedItems.push({ kind: 'attachment', path, sizeBytes });
      continue;
    }
    nextAttachments.push(row);
  }

  const result = {
    payload: {
      ...payload,
      db: {
        ...payload.db,
        attachments: nextAttachments,
      },
    },
    skipped: {
      reason: skippedItems.length ? 'Some remote attachments were unavailable and were skipped' : null,
      attachments: skippedItems.length,
      items: skippedItems,
    },
  };
  return result;
}

async function removeAttachmentRows(db: D1Database, attachmentRows: SqlRow[], useShadowTable: boolean = false): Promise<void> {
  if (!attachmentRows.length) return;
  const tableName = useShadowTable ? shadowTableName('attachments') : 'attachments';
  const statements = attachmentRows
    .map((row) => {
      const attachmentId = String(row.id || '').trim();
      const cipherId = String(row.cipher_id || '').trim();
      if (!attachmentId || !cipherId) return null;
      return db.prepare(`DELETE FROM ${tableName} WHERE id = ? AND cipher_id = ?`).bind(attachmentId, cipherId);
    })
    .filter((statement): statement is D1PreparedStatement => !!statement);
  if (!statements.length) return;
  await db.batch(statements);
}

async function restoreRemoteAttachmentFiles(
  env: Env,
  payload: BackupPayload,
  files: Record<string, Uint8Array>,
  source: RemoteAttachmentSource,
  keepKeys: Set<string>
): Promise<{
  imported: number;
  skipped: BackupImportSkipSummary;
  restoredAttachments: SqlRow[];
  writtenKeys: string[];
  overwritten: BlobRollbackStash;
}> {
  const manifestLookup = buildAttachmentBlobLookup(payload.manifest);
  const restoredAttachments: SqlRow[] = [];
  const skippedItems: BackupImportSkipSummary['items'] = [];
  // 同 restoreBlobFiles：失败时必须能回退这次写进去的对象。
  const writtenKeys: string[] = [];
  const overwritten = createBlobRollbackStash();

  for (const row of payload.db.attachments || []) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    const inlinePath = `attachments/${cipherId}/${attachmentId}.bin`;
    const ref = manifestLookup.get(`${cipherId}/${attachmentId}`);
    if (!ref && !files[inlinePath]) {
      skippedItems.push({
        kind: 'attachment',
        path: `attachments/${cipherId}/${attachmentId}`,
        sizeBytes: Number(row.size || 0) || 0,
      });
      continue;
    }
    const bytes = files[inlinePath] || (ref ? await source.loadAttachment(ref.blobName) : null);
    if (!bytes) {
      skippedItems.push({
        kind: 'attachment',
        path: ref ? `attachments/${ref.blobName}` : inlinePath,
        sizeBytes: ref?.sizeBytes || Number(row.size || 0) || 0,
      });
      continue;
    }
    try {
      const objectKey = getAttachmentObjectKey(cipherId, attachmentId);
      await stashLiveBlobIfOverwriting(env, objectKey, keepKeys, overwritten);
      await putBlobObject(env, objectKey, bytes, {
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
      });
      writtenKeys.push(objectKey);
      restoredAttachments.push(row);
    } catch {
      skippedItems.push({
        kind: 'attachment',
        path: ref ? `attachments/${ref.blobName}` : inlinePath,
        sizeBytes: bytes.byteLength,
      });
    }
  }

  return {
    imported: restoredAttachments.length,
    restoredAttachments,
    writtenKeys,
    overwritten,
    skipped: {
      reason: skippedItems.length ? ATTACHMENT_RESTORE_FAILED_REASON : null,
      attachments: skippedItems.length,
      items: skippedItems,
    },
  };
}

async function cleanupOrphanedBlobFiles(env: Env, beforeKeys: Set<string>, afterKeys: Set<string>): Promise<void> {
  const staleKeys = Array.from(beforeKeys).filter((key) => !afterKeys.has(key));
  for (const key of staleKeys) {
    await deleteBlobObject(env, key);
  }
}

/**
 * 失败回退用的暂存：记录「被本次写入覆盖掉的活库附件原内容」，失败时放回去。
 * 只在键与活库撞车（同实例恢复）时才有条目。
 *
 * ⚠️ 上限是必需的：Workers 内存上限 128 MB，而撞车键可能等于**整份活库附件**。
 * 超限的键记进 `skippedKeys`，失败时**不删**（删了会毁活库数据），只记日志点名。
 */
const MAX_BLOB_ROLLBACK_STASH_BYTES = 16 * 1024 * 1024;

interface BlobRollbackStash {
  originals: Map<string, Uint8Array>;
  bytes: number;
  skippedKeys: string[];
}

function createBlobRollbackStash(): BlobRollbackStash {
  return { originals: new Map(), bytes: 0, skippedKeys: [] };
}

/** 把一次 restore 的暂存并进整次恢复的暂存（本地/远端各调用一次 restore）。 */
function mergeBlobRollbackStash(target: BlobRollbackStash, source: BlobRollbackStash): void {
  for (const [key, bytes] of source.originals) {
    if (target.originals.has(key)) continue;
    target.originals.set(key, bytes);
    target.bytes += bytes.byteLength;
  }
  for (const key of source.skippedKeys) {
    if (!target.skippedKeys.includes(key)) target.skippedKeys.push(key);
  }
}

/** 写新内容之前，若该键正被活库引用，先把原内容留在手边（失败时放回去）。 */
async function stashLiveBlobIfOverwriting(
  env: Env,
  objectKey: string,
  keepKeys: Set<string>,
  stash: BlobRollbackStash
): Promise<void> {
  if (!keepKeys.has(objectKey) || stash.originals.has(objectKey) || stash.skippedKeys.includes(objectKey)) return;
  const existing = await getBlobObject(env, objectKey);
  if (!existing?.body) return;
  const size = Number(existing.size) || 0;
  if (size > 0 && stash.bytes + size > MAX_BLOB_ROLLBACK_STASH_BYTES) {
    stash.skippedKeys.push(objectKey);
    return;
  }
  const bytes = new Uint8Array(await new Response(existing.body).arrayBuffer());
  stash.originals.set(objectKey, bytes);
  stash.bytes += bytes.byteLength;
}

/**
 * 恢复**失败**时回退本次写进去的附件对象，让 blob 存储回到失败前的状态。
 *
 * 附件是在换表之前就写进 R2/KV 的，而失败路径只丢影子表 ⇒ 不清理会留下两种残留：
 * · 备份来自别的实例 ⇒ 多出无引用的对象（永久占空间）；
 * · 备份来自**同一实例** ⇒ 键名相同，活库附件被备份里的旧版本静默覆盖（下载不校验大小）。
 */
async function rollbackWrittenBlobFiles(env: Env, writtenKeys: string[], stash: BlobRollbackStash): Promise<void> {
  for (const key of writtenKeys) {
    const original = stash.originals.get(key);
    if (original) {
      // 撞车的键必须**还原内容**（删除是错的：活库还指着它）。
      await putBlobObject(env, key, original, {
        size: original.byteLength,
        contentType: 'application/octet-stream',
      });
      continue;
    }
    if (stash.skippedKeys.includes(key)) {
      console.warn(`Backup restore rollback: keeping overwritten attachment ${key} (rollback stash over budget)`);
      continue;
    }
    await deleteBlobObject(env, key);
  }
}

async function importBackupRows(db: D1Database, payload: BackupPayload['db'], useShadowTables: boolean = false): Promise<void> {
  const tableName = (table: BackupTableName): string => (useShadowTables ? shadowTableName(table) : table);
  await insertRows(db, tableName('config'), ['key', 'value'], payload.config || [], true);
  await insertRows(
    db,
    tableName('users'),
    ['id', 'email', 'name', 'master_password_hint', 'master_password_hash', 'key', 'private_key', 'public_key', 'kdf_type', 'kdf_iterations', 'kdf_memory', 'kdf_parallelism', 'security_stamp', 'role', 'status', 'verify_devices', 'totp_secret', 'totp_recovery_code', 'yubikey_key1', 'yubikey_key2', 'yubikey_key3', 'yubikey_key4', 'yubikey_key5', 'yubikey_nfc', 'email_verified', 'locale', 'auto_locale', 'timezone', 'auto_timezone', 'mail_opt_in', 'two_factor_email_enabled', 'two_factor_default_provider', 'created_at', 'updated_at'],
    payload.users || []
  );
  await insertRows(db, tableName('user_revisions'), ['user_id', 'revision_date'], payload.user_revisions || [], true);
  await insertRows(
    db,
    tableName('domain_settings'),
    ['user_id', 'equivalent_domains', 'custom_equivalent_domains', 'excluded_global_equivalent_domains', 'updated_at'],
    payload.domain_settings || [],
    true
  );
  await insertRows(
    db,
    tableName('webauthn_credentials'),
    ['id', 'user_id', 'purpose', 'name', 'public_key', 'credential_id', 'counter', 'type', 'aa_guid', 'transports', 'encrypted_user_key', 'encrypted_public_key', 'encrypted_private_key', 'supports_prf', 'created_at', 'updated_at'],
    payload.webauthn_credentials || []
  );
  await insertRows(db, tableName('folders'), ['id', 'user_id', 'name', 'created_at', 'updated_at'], payload.folders || []);
  await insertRows(
    db,
    tableName('ciphers'),
    ['id', 'user_id', 'type', 'folder_id', 'name', 'notes', 'favorite', 'data', 'reprompt', 'key', 'created_at', 'updated_at', 'archived_at', 'deleted_at'],
    payload.ciphers || []
  );
  await insertRows(db, tableName('attachments'), ['id', 'cipher_id', 'file_name', 'size', 'size_name', 'key'], payload.attachments || []);
  // 机密管理器：列清单必须与导出侧 SELECT 一致（少了列会静默丢数据）。
  await insertRows(
    db,
    tableName('sm_organizations'),
    ['id', 'owner_user_id', 'created_at'],
    payload.sm_organizations || []
  );
  await insertRows(db, tableName('sm_org_keys'), ['org_id', 'wrapped_org_key', 'created_at'], payload.sm_org_keys || []);
  await insertRows(
    db,
    tableName('sm_projects'),
    ['id', 'org_id', 'name_encrypted', 'created_at', 'revision_date'],
    payload.sm_projects || []
  );
  await insertRows(
    db,
    tableName('sm_machine_accounts'),
    ['id', 'org_id', 'name', 'created_at', 'revision_date'],
    payload.sm_machine_accounts || []
  );
  await insertRows(
    db,
    tableName('sm_secrets'),
    ['id', 'org_id', 'key_encrypted', 'value_encrypted', 'note_encrypted', 'tag_encrypted', 'created_at', 'revision_date', 'deleted_at'],
    payload.sm_secrets || []
  );
  await insertRows(
    db,
    tableName('sm_secret_projects'),
    ['secret_id', 'project_id'],
    payload.sm_secret_projects || []
  );
  await insertRows(
    db,
    tableName('sm_machine_account_projects'),
    ['machine_account_id', 'project_id', 'permission'],
    payload.sm_machine_account_projects || []
  );
  await insertRows(
    db,
    tableName('sm_access_tokens'),
    ['id', 'machine_account_id', 'org_id', 'name', 'secret_hash', 'encrypted_payload', 'expires_at', 'revoked_at', 'last_used_at', 'created_at'],
    payload.sm_access_tokens || []
  );
}

export async function importBackupArchiveBytes(
  archiveBytes: Uint8Array,
  env: Env,
  actorUserId: string,
  replaceExisting: boolean,
  progress?: BackupRestoreProgressReporter,
  fileName: string = 'nodewarden_backup.zip'
): Promise<BackupImportExecutionResult> {
  const parsed = parseBackupArchive(archiveBytes);
  validateBackupPayloadContents(parsed.payload, parsed.files);
  const prepared = prepareImportPayloadForTarget(env, parsed.payload, parsed.files);

  try {
    await ensureImportTargetIsFresh(env.DB);
  } catch (error) {
    if (!replaceExisting) {
      throw error instanceof Error ? error : new Error('Backup import requires a fresh instance');
    }
  }

  await resetRestoreArtifacts(env.DB);
  // `previousBlobKeys` 既是成功路径的对比物，也是**失败回退的保留集**：失败后活库未作改动，
  // 所以「仍被引用的键」就是这份快照。
  const previousBlobKeys = replaceExisting ? await collectCurrentBlobKeys(env.DB) : new Set<string>();
  const writtenBlobKeys: string[] = [];
  const overwrittenBlobs = createBlobRollbackStash();
  try {
    await reportProgress(progress, {
      source: 'local',
      step: 'local_create_shadow',
      fileName,
      stageTitle: 'txt_backup_restore_progress_local_shadow_title',
      stageDetail: 'txt_backup_restore_progress_local_shadow_detail',
      replaceExisting,
    });
    await createShadowTables(env.DB);
    await reportProgress(progress, {
      source: 'local',
      step: 'local_import_data',
      fileName,
      stageTitle: 'txt_backup_restore_progress_local_data_title',
      stageDetail: 'txt_backup_restore_progress_local_data_detail',
      replaceExisting,
    });
    const db = await importPreparedBackupRows(env.DB, prepared.payload.db, env);
    await validateShadowTableCounts(env.DB, expectedShadowCounts(db, (db.attachments || []).length));

    await reportProgress(progress, {
      source: 'local',
      step: 'local_restore_files',
      fileName,
      stageTitle: 'txt_backup_restore_progress_local_files_title',
      stageDetail: 'txt_backup_restore_progress_local_files_detail',
      replaceExisting,
    });
    const restored = await restoreBlobFiles(env, db, parsed.files, previousBlobKeys);
    writtenBlobKeys.push(...restored.writtenKeys);
    mergeBlobRollbackStash(overwrittenBlobs, restored.overwritten);
    const restoredAttachmentKeys = new Set((restored.restoredAttachments || []).map(attachmentRowKey));
    const failedRestoreRows = (db.attachments || []).filter((row) => !restoredAttachmentKeys.has(attachmentRowKey(row)));
    await removeAttachmentRows(env.DB, failedRestoreRows, true).catch(() => undefined);
    await validateShadowTableCounts(env.DB, expectedShadowCounts(db, restored.restoredAttachments.length));
    await reportProgress(progress, {
      source: 'local',
      step: 'local_finalize',
      fileName,
      stageTitle: 'txt_backup_restore_progress_local_finalize_title',
      stageDetail: 'txt_backup_restore_progress_local_finalize_detail',
      replaceExisting,
    });
    await swapShadowTablesIntoPlace(env.DB);
    await resetRestoreArtifacts(env.DB).catch(() => undefined);
    if (replaceExisting && previousBlobKeys.size) {
      const nextBlobKeys = await collectCurrentBlobKeys(env.DB).catch(() => null);
      if (nextBlobKeys) {
        await cleanupOrphanedBlobFiles(env, previousBlobKeys, nextBlobKeys).catch(() => undefined);
      }
    }

    await reportProgress(progress, {
      source: 'local',
      step: 'local_complete',
      fileName,
      stageTitle: 'txt_backup_restore_progress_local_finalize_title',
      stageDetail: 'txt_backup_restore_progress_local_finalize_detail',
      replaceExisting,
      done: true,
      ok: true,
    });
    return {
      auditActorUserId: (db.users || []).some((row) => String(row.id || '').trim() === actorUserId) ? actorUserId : null,
      result: {
        object: 'instance-backup-import',
        imported: {
          config: (db.config || []).length,
          users: (db.users || []).length,
          domainSettings: (db.domain_settings || []).length,
          userRevisions: (db.user_revisions || []).length,
          webauthnCredentials: (db.webauthn_credentials || []).length,
          folders: (db.folders || []).length,
          ciphers: (db.ciphers || []).length,
          attachments: restored.restoredAttachments.length,
          attachmentFiles: restored.imported,
          smProjects: (db.sm_projects || []).length,
          smSecrets: (db.sm_secrets || []).length,
          smMachineAccounts: (db.sm_machine_accounts || []).length,
          smAccessTokens: (db.sm_access_tokens || []).length,
        },
        skipped: {
          reason: restored.skipped.reason || prepared.skipped.reason,
          attachments: prepared.skipped.attachments + restored.skipped.attachments,
          items: [...prepared.skipped.items, ...restored.skipped.items],
        },
      },
    };
  } catch (error) {
    await reportProgress(progress, {
      source: 'local',
      step: 'local_failed',
      fileName,
      stageTitle: 'txt_backup_restore_failed',
      stageDetail: 'txt_backup_restore_progress_local_failed_detail',
      replaceExisting,
      done: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    // 附件比换表先落盘 ⇒ 失败必须回退：删掉活库不引用的新对象、把被覆盖的活库附件放回去。
    await rollbackWrittenBlobFiles(env, writtenBlobKeys, overwrittenBlobs).catch(() => undefined);
    await resetRestoreArtifacts(env.DB).catch(() => undefined);
    throw error;
  }
}

export async function importRemoteBackupArchiveBytes(
  archiveBytes: Uint8Array,
  env: Env,
  actorUserId: string,
  replaceExisting: boolean,
  source: RemoteAttachmentSource,
  progress?: BackupRestoreProgressReporter,
  fileName: string = 'nodewarden_backup.zip'
): Promise<BackupImportExecutionResult> {
  const parsed = parseBackupArchive(archiveBytes, { allowExternalAttachmentBlobs: true });
  const preparedRemote = await prepareRemoteAttachmentPayload(env, parsed.payload, parsed.files, source);
  validateBackupPayloadContents(preparedRemote.payload, parsed.files, { allowExternalAttachmentBlobs: true });

  try {
    await ensureImportTargetIsFresh(env.DB);
  } catch (error) {
    if (!replaceExisting) {
      throw error instanceof Error ? error : new Error('Backup import requires a fresh instance');
    }
  }

  await resetRestoreArtifacts(env.DB);
  const previousBlobKeys = replaceExisting ? await collectCurrentBlobKeys(env.DB) : new Set<string>();
  const writtenBlobKeys: string[] = [];
  const overwrittenBlobs = createBlobRollbackStash();
  try {
    await reportProgress(progress, {
      source: 'remote',
      step: 'remote_create_shadow',
      fileName,
      stageTitle: 'txt_backup_restore_progress_remote_shadow_title',
      stageDetail: 'txt_backup_restore_progress_remote_shadow_detail',
      replaceExisting,
    });
    await createShadowTables(env.DB);
    await reportProgress(progress, {
      source: 'remote',
      step: 'remote_import_data',
      fileName,
      stageTitle: 'txt_backup_restore_progress_remote_data_title',
      stageDetail: 'txt_backup_restore_progress_remote_data_detail',
      replaceExisting,
    });
    const db = await importPreparedBackupRows(env.DB, preparedRemote.payload.db, env);
    await validateShadowTableCounts(env.DB, expectedShadowCounts(db, (db.attachments || []).length));

    await reportProgress(progress, {
      source: 'remote',
      step: 'remote_restore_files',
      fileName,
      stageTitle: 'txt_backup_restore_progress_remote_files_title',
      stageDetail: 'txt_backup_restore_progress_remote_files_detail',
      replaceExisting,
    });
    const restored = await restoreRemoteAttachmentFiles(env, preparedRemote.payload, parsed.files, source, previousBlobKeys);
    writtenBlobKeys.push(...restored.writtenKeys);
    mergeBlobRollbackStash(overwrittenBlobs, restored.overwritten);
    const restoredAttachmentKeys = new Set((restored.restoredAttachments || []).map(attachmentRowKey));
    const failedRestoreRows = (db.attachments || []).filter((row) => !restoredAttachmentKeys.has(attachmentRowKey(row)));
    await removeAttachmentRows(env.DB, failedRestoreRows, true).catch(() => undefined);
    await validateShadowTableCounts(env.DB, expectedShadowCounts(db, restored.restoredAttachments.length));
    await reportProgress(progress, {
      source: 'remote',
      step: 'remote_finalize',
      fileName,
      stageTitle: 'txt_backup_restore_progress_remote_finalize_title',
      stageDetail: 'txt_backup_restore_progress_remote_finalize_detail',
      replaceExisting,
    });
    await swapShadowTablesIntoPlace(env.DB);
    await resetRestoreArtifacts(env.DB).catch(() => undefined);

    if (replaceExisting && previousBlobKeys.size) {
      const nextBlobKeys = await collectCurrentBlobKeys(env.DB).catch(() => null);
      if (nextBlobKeys) {
        await cleanupOrphanedBlobFiles(env, previousBlobKeys, nextBlobKeys).catch(() => undefined);
      }
    }

    await reportProgress(progress, {
      source: 'remote',
      step: 'remote_complete',
      fileName,
      stageTitle: 'txt_backup_restore_progress_remote_finalize_title',
      stageDetail: 'txt_backup_restore_progress_remote_finalize_detail',
      replaceExisting,
      done: true,
      ok: true,
    });
    const finalSkippedItems = [...preparedRemote.skipped.items, ...restored.skipped.items];
    const finalSkippedReason = finalSkippedItems.length
      ? restored.skipped.reason || preparedRemote.skipped.reason
      : null;

    return {
      auditActorUserId: (db.users || []).some((row) => String(row.id || '').trim() === actorUserId) ? actorUserId : null,
      result: {
        object: 'instance-backup-import',
        imported: {
          config: (db.config || []).length,
          users: (db.users || []).length,
          domainSettings: (db.domain_settings || []).length,
          userRevisions: (db.user_revisions || []).length,
          webauthnCredentials: (db.webauthn_credentials || []).length,
          folders: (db.folders || []).length,
          ciphers: (db.ciphers || []).length,
          attachments: restored.restoredAttachments.length,
          attachmentFiles: restored.imported,
          smProjects: (db.sm_projects || []).length,
          smSecrets: (db.sm_secrets || []).length,
          smMachineAccounts: (db.sm_machine_accounts || []).length,
          smAccessTokens: (db.sm_access_tokens || []).length,
        },
        skipped: {
          reason: finalSkippedReason,
          attachments: finalSkippedItems.length,
          items: finalSkippedItems,
        },
      },
    };
  } catch (error) {
    await reportProgress(progress, {
      source: 'remote',
      step: 'remote_failed',
      fileName,
      stageTitle: 'txt_backup_remote_restore_failed',
      stageDetail: 'txt_backup_restore_progress_remote_failed_detail',
      replaceExisting,
      done: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    // 同本地路径：附件比换表先落盘，失败必须回退（删新对象 + 放回被覆盖的活库附件）。
    await rollbackWrittenBlobFiles(env, writtenBlobKeys, overwrittenBlobs).catch(() => undefined);
    await resetRestoreArtifacts(env.DB).catch(() => undefined);
    throw error;
  }
}

import type {
  RawSecretDetail,
  RawSecretProject,
  RawSecretSummary,
  RawTrashedSecret,
  RawTrashedSecretDetail,
} from './api/secrets';

/**
 * 机密管理器的离线只读缓存：**只存密文，明文永不落盘**（与 `vault-cache.ts` 同一套规矩）。
 * 组织密钥也只存「被用户密钥加密过的包裹」，保护级别与密码库一致。
 *
 * 三条有意的取舍：
 * - 机器账号 / 访问令牌 / 授权**不入缓存**（凭据一旦落盘就是明文）。
 * - 回收站没有批量详情接口（`get-by-ids` 跳过已删除的）⇒ 内容只能靠看过的条目惰性积累。
 * - 分区键只用「用户」：离线时拿不到组织 id（要联网反查），而本产品一人只有一个隐式组织
 *   ⇒ 两者等价，组织 id 记在记录里。
 */

const DB_NAME = 'nodewarden-sm-cache';
const DB_VERSION = 1;
const SM_CORE_STORE = 'sm-core';

export interface SecretsOfflineCacheRecord {
  /** 与 `vaultCacheKey` 同口径：`profile.id` 优先、回落邮箱。 */
  cacheKey: string;
  savedAt: number;
  organizationId: string;
  /** 在线列表的 `id + revisionDate` 签名：一致即跳过全量拉取（线格式不报删除，只能全量覆盖）。 */
  signature: string;
  /** 组织密钥的包裹（用户密钥加密），解锁后据此解出组织密钥。 */
  wrappedOrgKey: string;
  projects: RawSecretProject[];
  /** 含 value / note 的密文快照。 */
  secrets: RawSecretDetail[];
  trash: RawTrashedSecret[];
  /** 看过内容的回收站条目（键为机密 id）。 */
  trashDetails: Record<string, RawTrashedSecretDetail>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!supportsIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SM_CORE_STORE)) {
          db.createObjectStore(SM_CORE_STORE, { keyPath: 'cacheKey' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T | null> {
  return openDatabase().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(SM_CORE_STORE, mode);
        const store = tx.objectStore(SM_CORE_STORE);
        void run(store).then(resolve).catch(() => resolve(null));
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

function readRecord(store: IDBObjectStore, cacheKey: string): Promise<SecretsOfflineCacheRecord | null> {
  return new Promise((resolve) => {
    const request = store.get(cacheKey);
    request.onsuccess = () => resolve((request.result as SecretsOfflineCacheRecord | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

function writeRecord(store: IDBObjectStore, record: SecretsOfflineCacheRecord): Promise<void> {
  return new Promise((resolve) => {
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

export async function loadSecretsOfflineCache(cacheKey: string): Promise<SecretsOfflineCacheRecord | null> {
  const normalized = String(cacheKey || '').trim();
  if (!normalized) return null;
  const record = await withStore('readonly', (store) => readRecord(store, normalized));
  if (!record) return null;
  // 坏记录（旧格式 / 手改）不该让页面崩：字段缺失就整体丢弃，等下次在线重建。
  if (!record.wrappedOrgKey || !record.organizationId) return null;
  return {
    ...record,
    projects: Array.isArray(record.projects) ? record.projects : [],
    secrets: Array.isArray(record.secrets) ? record.secrets : [],
    trash: Array.isArray(record.trash) ? record.trash : [],
    trashDetails: record.trashDetails && typeof record.trashDetails === 'object' ? record.trashDetails : {},
  };
}

export async function saveSecretsOfflineCache(
  cacheKey: string,
  record: Omit<SecretsOfflineCacheRecord, 'cacheKey' | 'savedAt'>
): Promise<void> {
  const normalized = String(cacheKey || '').trim();
  if (!normalized) return;
  await withStore('readwrite', (store) =>
    writeRecord(store, { ...record, cacheKey: normalized, savedAt: Date.now() })
  );
}

/**
 * 补一条「看过内容」的回收站条目。
 *
 * 读-改-写分两个事务：同一事务里先 `get` 再 `put` 会在部分浏览器上撞
 * `TransactionInactiveError`（事务在没有待处理请求时会自动提交）。并发只可能来自
 * 同一标签页的连续选中，后写者覆盖前者即可。
 */
export async function saveCachedSecretsOfflineTrashDetail(
  cacheKey: string,
  id: string,
  detail: RawTrashedSecretDetail
): Promise<void> {
  const normalized = String(cacheKey || '').trim();
  if (!normalized || !id) return;
  const record = await loadSecretsOfflineCache(normalized);
  if (!record) return;
  // 垃圾回收：只保留还在回收站里的条目，避免长期累积。
  const aliveIds = new Set(record.trash.map((row) => row.id).filter((rowId): rowId is string => !!rowId));
  const trashDetails = Object.fromEntries(
    Object.entries({ ...record.trashDetails, [id]: detail }).filter(([key]) => aliveIds.has(key))
  );
  await withStore('readwrite', (store) => writeRecord(store, { ...record, trashDetails }));
}

export async function clearSecretsOfflineCache(cacheKey: string): Promise<void> {
  const normalized = String(cacheKey || '').trim();
  if (!normalized) return;
  await withStore('readwrite', (store) => new Promise<void>((resolve) => {
    const request = store.delete(normalized);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  }));
}

/** 列表签名：`id + revisionDate`（id 集合变化 = 增删，revisionDate 变化 = 改）。 */
export function secretsOfflineSignature(
  secrets: RawSecretSummary[],
  projects: RawSecretProject[]
): string {
  const parts = [
    ...secrets.map((secret) => `s:${secret?.id ?? ''}:${secret?.revisionDate ?? ''}`),
    ...projects.map((project) => `p:${project?.id ?? ''}:${project?.revisionDate ?? ''}`),
  ];
  return parts.sort().join('|');
}

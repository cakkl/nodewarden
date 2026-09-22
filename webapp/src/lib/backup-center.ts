import {
  type BackupDestinationRecord,
  type BackupDestinationType,
  type BackupRuntimeState,
  type BackupSettings,
  createBackupDestinationRecord,
  createDefaultBackupSettings,
  isBackupDestinationConfigured,
} from '@shared/backup-schema';
import type { RemoteBackupBrowserResponse, RemoteBackupItem } from './api/backup';
import { DEFAULT_DATE_TIME_PREFS, detectBrowserTimeZone, formatDateTimeInPrefs, type DateTimePrefs } from './datetime';

export { isBackupDestinationConfigured };
// 时区检测的唯一实现在 `lib/datetime.ts`；这里转发导出，既有 import 路径不变。
export { detectBrowserTimeZone };
import { t, translateServerError } from './i18n';

export interface PersistedRemoteBrowserState {
  cache: Record<string, RemoteBackupBrowserResponse>;
  pathByDestination: Record<string, string>;
  pageByKey: Record<string, number>;
  selectedDestinationId: string | null;
  refreshedAt: Record<string, number>;
}

export const REMOTE_BROWSER_STORAGE_KEY = 'nodewarden.backup.remote-browser.v1';
export const REMOTE_BROWSER_ITEMS_PER_PAGE = 10;
export const REMOTE_BROWSER_REFRESH_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const COMMON_TIME_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];

export const WEEKDAY_OPTIONS = [
  { value: 1, label: 'txt_backup_weekday_monday' },
  { value: 2, label: 'txt_backup_weekday_tuesday' },
  { value: 3, label: 'txt_backup_weekday_wednesday' },
  { value: 4, label: 'txt_backup_weekday_thursday' },
  { value: 5, label: 'txt_backup_weekday_friday' },
  { value: 6, label: 'txt_backup_weekday_saturday' },
  { value: 0, label: 'txt_backup_weekday_sunday' },
] as const;

function createLocalizedDestinationName(type: BackupDestinationType, index: number): string {
  if (type === 's3') return t('txt_backup_destination_name_default_s3', { index: String(index) });
  return t('txt_backup_destination_name_default_webdav', { index: String(index) });
}

export function createDraftDestinationRecord(type: BackupDestinationType, index: number): BackupDestinationRecord {
  return createBackupDestinationRecord(type, index, {
    timezone: detectBrowserTimeZone(),
    name: createLocalizedDestinationName(type, index),
  });
}

export function createDraftBackupSettings(): BackupSettings {
  return createDefaultBackupSettings(detectBrowserTimeZone(), {
    destinationName: createLocalizedDestinationName('webdav', 1),
  });
}

export function formatDateTime(
  value: string | null | undefined,
  prefs: DateTimePrefs = DEFAULT_DATE_TIME_PREFS
): string {
  if (!value) return t('txt_backup_never');
  // 解析失败时保留原样回显（对排障比一个占位符有用）
  return formatDateTimeInPrefs(value, prefs) ?? value;
}

export function formatBytes(value: number | null | undefined): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return t('txt_backup_unknown_size');
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface DestinationRuntimeSummary {
  /** 「上次失败：<时间>」；没失败过则为 null */
  failedAt: string | null;
  /** 失败原因；没失败过则为 null */
  failureReason: string | null;
}

/** 解析时间戳；无法解析时返回 null（不回退到 0，免得把「坏值」当成「最早」） */
function parseTimestampMs(value: string | null | undefined): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 备份目标的「上次失败」摘要（地点列表与详情页共用）。
 *
 * **只有最后一次尝试是失败的才显示**：后端在**成功**时会清空 `lastError*`，但归档恢复、手工改配置
 * 等途径可能带进「成功时间晚于失败时间」的旧状态，那时这条消息已过时；而时间解析失败时**保持显示**
 * —— 宁可多提示一次，也别把真实失败藏起来。
 *
 * 失败原因走 `translateServerError()`：后端文案是英文（如 `WebDAV upload timed out after 30000 ms`），
 * 命中映射表就本地化，未命中则**保留英文原文** —— 刻意不回落到通用文案，具体原因才是排障线索。
 */
export function getDestinationRuntimeSummary(
  runtime: BackupRuntimeState,
  prefs: DateTimePrefs = DEFAULT_DATE_TIME_PREFS
): DestinationRuntimeSummary {
  const reason = String(runtime.lastErrorMessage || '').trim();
  if (!reason) return { failedAt: null, failureReason: null };

  const errorMs = parseTimestampMs(runtime.lastErrorAt);
  const successMs = parseTimestampMs(runtime.lastSuccessAt);
  if (errorMs !== null && successMs !== null && successMs > errorMs) {
    return { failedAt: null, failureReason: null };
  }

  return {
    failedAt: t('txt_backup_destination_failed_at', { time: formatDateTime(runtime.lastErrorAt, prefs) }),
    failureReason: translateServerError(reason, reason),
  };
}

export function isReplaceRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? String(error.message || '') : '';
  return message.toLowerCase().includes('fresh instance');
}

export function isZipCandidate(item: RemoteBackupItem): boolean {
  return !item.isDirectory && /\.zip$/i.test(item.name || '');
}

function getRemoteItemSortTime(item: RemoteBackupItem): number {
  if (!item.modifiedAt) return 0;
  const parsed = new Date(item.modifiedAt);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

export function compareRemoteItems(a: RemoteBackupItem, b: RemoteBackupItem): number {
  const aIsAttachmentsDir = a.isDirectory && a.name === 'attachments';
  const bIsAttachmentsDir = b.isDirectory && b.name === 'attachments';
  if (aIsAttachmentsDir !== bIsAttachmentsDir) return aIsAttachmentsDir ? -1 : 1;
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const timeDiff = getRemoteItemSortTime(b) - getRemoteItemSortTime(a);
  if (timeDiff !== 0) return timeDiff;
  return b.name.localeCompare(a.name, 'en');
}

/**
 * 备份目标「访问配置」指纹：只取决定「能不能连上、连到哪里」的字段，用作远端目录自动刷新的触发条件。
 *
 * 不用目标对象本身比较：名称、调度、`runtime` 与「列目录」无关，按引用判断会让这些改动也白跑一次远端
 * 列举。返回值必须是**字符串**：`loadRemoteBrowser` 每次都造新对象写回 `pathByDestination`，引用永不
 * 相等 ⇒ 放进 effect 依赖会在加载失败时无限重试（`catch` 分支不更新 `refreshedAt`）。
 *
 * 用 `JSON.stringify` 而非自定义分隔符：避免「`username` 的尾巴 + `remotePath` 的头」这类相邻字段互相
 * 顶替。刻意**不含密码 / `secretAccessKey`**：只用来比较变更，没必要复制密钥；「只改了密码」极少见，
 * 手动刷新一次即可。
 */
export function getBackupDestinationAccessFingerprint(destination: BackupDestinationRecord | null | undefined): string {
  if (!destination) return '';
  const config = destination.destination as unknown as Record<string, unknown>;
  const parts = destination.type === 's3'
    ? ['s3', config.endpoint, config.bucket, config.region, config.addressingStyle, config.rootPath]
    : ['webdav', config.baseUrl, config.username, config.remotePath];
  return JSON.stringify(parts.map((value) => String(value ?? '').trim()));
}

/**
 * 保存后是否需要作废该目标的远端目录缓存。
 *
 * 背景：保存逻辑原先**无条件**清缓存，于是「只改名字 / 改调度」也会把用户正看着的文件列表清空 ——
 * 而刷新 effect 的依赖（目标 id + 访问配置指纹）都没变、不会重载，列表就一直空着，只能手动刷新。
 *
 * 判据：只有「访问配置」变了才作废（旧列表是按旧地址 / 旧账号拉的，不可信）；目标记录整个消失（被删）
 * 时一并作废，别留残留键。
 */
export function shouldInvalidateRemoteBrowserCache(
  previous: BackupDestinationRecord | null | undefined,
  next: BackupDestinationRecord | null | undefined
): boolean {
  if (!next) return true;
  return getBackupDestinationAccessFingerprint(previous) !== getBackupDestinationAccessFingerprint(next);
}

export function getRemoteBrowserCacheKey(destinationId: string, path: string = ''): string {
  return `${destinationId}:${path}`;
}

function getRemoteBrowserStorageKey(userId?: string | null): string {
  const normalizedUserId = String(userId || '').trim();
  return normalizedUserId
    ? `${REMOTE_BROWSER_STORAGE_KEY}:${normalizedUserId}`
    : REMOTE_BROWSER_STORAGE_KEY;
}

function getRemoteBrowserStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access failures.
  }
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore storage access failures.
  }
  return null;
}

export function loadPersistedRemoteBrowserState(userId?: string | null): PersistedRemoteBrowserState {
  try {
    const storage = getRemoteBrowserStorage();
    const raw = storage?.getItem(getRemoteBrowserStorageKey(userId));
    if (!raw) {
      return {
        cache: {},
        pathByDestination: {},
        pageByKey: {},
        selectedDestinationId: null,
        refreshedAt: {},
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedRemoteBrowserState>;
    return {
      cache: parsed.cache && typeof parsed.cache === 'object' ? parsed.cache : {},
      pathByDestination: parsed.pathByDestination && typeof parsed.pathByDestination === 'object' ? parsed.pathByDestination : {},
      pageByKey: parsed.pageByKey && typeof parsed.pageByKey === 'object' ? parsed.pageByKey : {},
      selectedDestinationId: typeof parsed.selectedDestinationId === 'string' ? parsed.selectedDestinationId : null,
      refreshedAt: parsed.refreshedAt && typeof parsed.refreshedAt === 'object' ? parsed.refreshedAt as Record<string, number> : {},
    };
  } catch {
    return {
      cache: {},
      pathByDestination: {},
      pageByKey: {},
      selectedDestinationId: null,
      refreshedAt: {},
    };
  }
}

export function persistRemoteBrowserState(userId: string | null | undefined, state: PersistedRemoteBrowserState): void {
  try {
    const storage = getRemoteBrowserStorage();
    storage?.setItem(getRemoteBrowserStorageKey(userId), JSON.stringify(state));
  } catch {
    // Ignore cache persistence failures.
  }
}

export function invalidateRemoteBrowserCacheForDestination(
  destinationId: string,
  cache: Record<string, RemoteBackupBrowserResponse>,
  pathByDestination: Record<string, string>,
  pageByKey: Record<string, number>
): Omit<PersistedRemoteBrowserState, 'refreshedAt'> {
  return {
    cache: Object.fromEntries(Object.entries(cache).filter(([key]) => !key.startsWith(`${destinationId}:`))),
    pathByDestination: Object.fromEntries(Object.entries(pathByDestination).filter(([key]) => key !== destinationId)),
    pageByKey: Object.fromEntries(Object.entries(pageByKey).filter(([key]) => !key.startsWith(`${destinationId}:`))),
    selectedDestinationId: destinationId,
  };
}

export function getDestinationById(
  settings: BackupSettings | null,
  destinationId: string | null | undefined
): BackupDestinationRecord | null {
  if (!settings || !destinationId) return null;
  return settings.destinations.find((destination) => destination.id === destinationId) || null;
}

export function getVisibleDestinations(settings: BackupSettings | null | undefined): BackupDestinationRecord[] {
  return settings?.destinations || [];
}

export function getFirstVisibleDestinationId(settings: BackupSettings | null | undefined): string | null {
  return getVisibleDestinations(settings)[0]?.id || null;
}

export function getDestinationTypeLabel(type: BackupDestinationType): string {
  if (type === 's3') return t('txt_backup_protocol_s3');
  return t('txt_backup_protocol_webdav');
}

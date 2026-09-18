import {
  BackupDestinationRecord,
  BackupDestinationType,
  S3BackupDestination,
  WebDavBackupDestination,
  normalizeBackupEndpointUrl,
} from './backup-config';
import { isRequestTimeoutError, withRequestTimeout } from '../utils/request-timeout';

export interface BackupUploadResult {
  provider: BackupDestinationType;
  remotePath: string;
}

export interface RemoteBackupItem {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  modifiedAt: string | null;
}

export interface RemoteBackupListResult {
  provider: BackupDestinationType;
  currentPath: string;
  parentPath: string | null;
  items: RemoteBackupItem[];
}

export interface RemoteBackupFile {
  provider: BackupDestinationType;
  remotePath: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface RemoteBackupFileStat {
  provider: BackupDestinationType;
  remotePath: string;
  size: number | null;
  modifiedAt: string | null;
}

export interface RemoteBackupFilePutOptions {
  contentType?: string;
}

// ---------------------------------------------------------------- 远端请求超时
//
// 为什么要做：远端目的地不可达时（黑洞 IP、防火墙丢包、容器被暂停、TLS 握手挂住），
// `fetch()` 可能**永不 settle**。异常永远抛不出来 ⇒ 调用方的 catch 永不执行 ⇒ 请求一直挂着，
// 最后由平台兜底返回通用 500（`internal error; reference = …`），管理员拿到的信息量为零。
// 所以超时不是为了“限速”，而是为了让失败**真的成为一次失败**。
//
// 为什么要分档：控制类请求（MKCOL / HEAD / DELETE）只传几十字节；而单次传输可能是
// 100 MiB 的附件（`limits.attachment.maxFileSizeBytes`）或 64 MiB 的归档
// （`MAX_BACKUP_ARCHIVE_BYTES`），跨境上传远超几秒 ⇒ 传输类按体积估算，
// 避免把“慢但成功”误杀成失败。
// 超时消息的形状（构造 + 判定）来自 `shared/backup-timeout-message.ts`：
// 那句文本同时被前端 `translateServerError()` 解析，两边必须逐字一致。
import {
  REMOTE_TIMEOUT_MESSAGE_PATTERN,
  buildRemoteTimeoutMessage,
  type RemoteRequestAction,
} from '../../shared/backup-timeout-message';

export type { RemoteRequestAction };

export interface RemoteRequestTimeouts {
  /** 控制类请求（建目录 / 存在性检查 / 删除）的整段时长上限 */
  controlMs: number;
  /** 列目录（WebDAV PROPFIND / S3 ListObjectsV2）的整段时长上限 */
  listingMs: number;
  /** 等待首包（响应头）的上限，用于 GET 下载 */
  firstByteMs: number;
  /** 传输类（上传 / 下载 body）的下限：小文件也要给足建连与握手时间 */
  transferMinMs: number;
  /** 传输类上限：再慢也总得失败一次 */
  transferMaxMs: number;
  /** 估算传输耗时用的**保守**带宽假设（字节/秒） */
  transferBytesPerSecond: number;
}

export const DEFAULT_REMOTE_REQUEST_TIMEOUTS: RemoteRequestTimeouts = {
  controlMs: 5_000,
  listingMs: 10_000,
  firstByteMs: 10_000,
  transferMinMs: 30_000,
  transferMaxMs: 10 * 60 * 1000,
  // 256 KB/s：比任何可用链路都慢，宁可多给时间也不要误杀一次能成功的备份
  transferBytesPerSecond: 256 * 1024,
};

/**
 * 远端请求超时。与 HTTP 状态码类错误（`WebDAV upload failed: 403`）刻意区分开：
 * 调用方据此把它映射成**不可重试**的 4xx（见 `remoteRequestFailureStatus`）。
 */
export class RemoteRequestTimeoutError extends Error {
  constructor(
    readonly provider: 'WebDAV' | 'S3',
    readonly action: RemoteRequestAction,
    readonly timeoutMs: number
  ) {
    super(buildRemoteTimeoutMessage(provider, action, timeoutMs));
    this.name = 'RemoteRequestTimeoutError';
  }
}

export function isRemoteRequestTimeoutError(error: unknown): error is RemoteRequestTimeoutError {
  return error instanceof RemoteRequestTimeoutError;
}

/**
 * 超时消息的**形状**判定，供跨 JS 上下文使用：
 * DO 与 handler 之间传递的是 JSON，Error 对象不会原样过界，
 * 所以 handler 侧读回来的只有 message，只能按形状判断。
 * 形状与前端 `translateServerError` 的正则、以及本类的 `super(...)` 三者必须一致。
 */
export function isRemoteRequestTimeoutMessage(message: unknown): boolean {
  return typeof message === 'string' && REMOTE_TIMEOUT_MESSAGE_PATTERN.test(message);
}

/**
 * 超时必须映射成**不可重试**的 4xx。
 *
 * 原因：前端 `createAuthedFetch` 的 `retryableRequest` 对 429 与 5xx 会自动重试 3 次
 * （退避 250 / 500 ms）。若超时也回 500，一次超时会被放大成约三倍等待，
 * 管理员要等更久才看得到那条“可读的原因”。
 *
 * 既接受 Error（同进程）也接受字符串消息（DO → handler 的 JSON 回传）。
 */
export function remoteRequestFailureStatus(error: unknown, fallbackStatus = 500): number {
  if (isRemoteRequestTimeoutError(error)) return 400;
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return isRemoteRequestTimeoutMessage(message) ? 400 : fallbackStatus;
}

/** 把部分覆盖合并成完整配置；非法值（0 / 负数 / NaN）一律回退到默认，避免计时器立即触发或永不触发。 */
export function resolveRemoteRequestTimeouts(overrides?: Partial<RemoteRequestTimeouts>): RemoteRequestTimeouts {
  if (!overrides) return DEFAULT_REMOTE_REQUEST_TIMEOUTS;
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    controlMs: pick(overrides.controlMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.controlMs),
    listingMs: pick(overrides.listingMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.listingMs),
    firstByteMs: pick(overrides.firstByteMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.firstByteMs),
    transferMinMs: pick(overrides.transferMinMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.transferMinMs),
    transferMaxMs: pick(overrides.transferMaxMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.transferMaxMs),
    transferBytesPerSecond: pick(overrides.transferBytesPerSecond, DEFAULT_REMOTE_REQUEST_TIMEOUTS.transferBytesPerSecond),
  };
}

/** 传输类预算：已知字节数时按保守带宽估算，夹在 [transferMinMs, transferMaxMs] 之间。 */
function resolveTransferTimeoutMs(byteLength: number | undefined, timeouts: RemoteRequestTimeouts): number {
  if (!byteLength || byteLength <= 0) return timeouts.transferMinMs;
  const estimatedMs = Math.ceil((byteLength / timeouts.transferBytesPerSecond) * 1000);
  return Math.min(timeouts.transferMaxMs, Math.max(timeouts.transferMinMs, estimatedMs));
}

/**
 * 在**整段操作**（发送请求 + 读响应体）外包一层超时。
 *
 * 为什么不只包 `fetch()`：`fetch()` 在**收到响应头**时就 resolve 了，
 * 下载类请求还要 `await response.arrayBuffer()` 把 body 读进来 ——
 * 对端“发了头就不再发数据”时，卡住的正是读 body 这一步。
 *
 * 传入 `controller` 可复用同一个 AbortSignal：响应头已到达后再 `abort()`
 * 仍能中断 body 读取（下载路径正是这样拆成“首包 + body”两段计时的）。
 */
async function withRemoteTimeout<T>(
  provider: 'WebDAV' | 'S3',
  action: RemoteRequestAction,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  controller: AbortController = new AbortController()
): Promise<T> {
  try {
    // 计时/中断的实现在 utils/request-timeout.ts（与 Yubico 等其它外发路径共用同一份）
    return await withRequestTimeout(timeoutMs, run, controller);
  } catch (error) {
    // 换成带上「哪家 / 哪一步」的错误：前端按这个消息形状映射本地化文案
    // （见 webapp/src/lib/i18n.ts 里 `timed out after (\d+) ms` 的分支）
    if (isRequestTimeoutError(error)) throw new RemoteRequestTimeoutError(provider, action, timeoutMs);
    throw error;
  }
}

function isBackupArchiveName(name: string): boolean {
  return /\.zip$/i.test(String(name || '').trim());
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function trimSlashes(value: string): string {
  let next = String(value || '');
  while (next.startsWith('/')) next = next.slice(1);
  while (next.endsWith('/')) next = next.slice(0, -1);
  return next;
}

/**
 * 只去掉结尾的 `/`。
 *
 * 与 `baseUrl.replace(/\/+$/, '')` 等价，但用循环实现：尾部量词在 CodeQL 的
 * js/polynomial-redos 规则下会被报"长串同一字符时可能变慢"，这里没有任何回溯。
 */
function trimTrailingSlashes(value: string): string {
  const source = String(value || '');
  let end = source.length;
  while (end > 0 && source[end - 1] === '/') end -= 1;
  return source.slice(0, end);
}

function buildJoinedPath(...segments: string[]): string {
  return segments.map(trimSlashes).filter(Boolean).join('/');
}

function normalizeRelativePath(path: string): string {
  const normalized = trimSlashes(path).replace(/\\/g, '/');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid remote backup path');
  }
  return parts.join('/');
}

function basename(path: string): string {
  const normalized = trimSlashes(path);
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function parentPath(path: string): string | null {
  const normalized = normalizeRelativePath(path);
  if (!normalized) return null;
  const parts = normalized.split('/');
  parts.pop();
  return parts.length ? parts.join('/') : '';
}

function sortRemoteItems(items: RemoteBackupItem[]): RemoteBackupItem[] {
  return items.slice().sort((a, b) => {
    const aIsAttachmentsDir = a.isDirectory && a.name === 'attachments';
    const bIsAttachmentsDir = b.isDirectory && b.name === 'attachments';
    if (aIsAttachmentsDir !== bIsAttachmentsDir) return aIsAttachmentsDir ? -1 : 1;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'en');
  });
}

function decodeXmlText(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_match, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case '#39':
        return "'";
      default:
        return _match;
    }
  });
}

function parseHttpDate(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function extractXmlBlocks(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<(?:[^:>]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:[^:>]+:)?${tagName}>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractXmlFirst(xml: string, tagName: string): string | null {
  const pattern = new RegExp(`<(?:[^:>]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:[^:>]+:)?${tagName}>`, 'i');
  const match = xml.match(pattern);
  return match?.[1] ? decodeXmlText(match[1].trim()) : null;
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Raw(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function toBasicAuthHeader(username: string, password: string): string {
  const token = btoa(`${username}:${password}`);
  return `Basic ${token}`;
}

function buildCanonicalQueryString(url: URL): string {
  const params = Array.from(url.searchParams.entries()).sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) return aValue.localeCompare(bValue);
    return aKey.localeCompare(bKey);
  });
  return params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

async function buildAwsV4Authorization(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHashHex: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string> {
  const amzDate = headers['x-amz-date'];
  const shortDate = amzDate.slice(0, 8);
  const headerEntries = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const).sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = headerEntries
    .map(([name, value]) => `${name}:${String(value).trim().replace(/\s+/g, ' ')}`)
    .join('\n');
  const signedHeaders = headerEntries.map(([name]) => name).join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    buildCanonicalQueryString(url),
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHashHex,
  ].join('\n');
  const credentialScope = `${shortDate}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256Raw(new TextEncoder().encode(`AWS4${secretAccessKey}`), shortDate);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, 's3');
  const kSigning = await hmacSha256Raw(kService, 'aws4_request');
  const signatureBytes = await hmacSha256Raw(kSigning, stringToSign);
  const signature = Array.from(signatureBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function ensureDestinationConfigReady(destination: BackupDestinationRecord): void {
  if (destination.type === 'webdav') {
    const config = destination.destination as WebDavBackupDestination;
    if (!String(config.baseUrl || '').trim()) throw new Error('WebDAV server URL is required');
    normalizeBackupEndpointUrl(String(config.baseUrl || '').trim(), 'WebDAV server URL');
    if (!String(config.username || '').trim()) throw new Error('WebDAV username is required');
    if (!String(config.password || '')) throw new Error('WebDAV password is required');
    return;
  }
  if (destination.type === 's3') {
    const config = destination.destination as S3BackupDestination;
    if (!String(config.endpoint || '').trim()) throw new Error('S3 endpoint is required');
    normalizeBackupEndpointUrl(String(config.endpoint || '').trim(), 'S3 endpoint');
    if (!String(config.bucket || '').trim()) throw new Error('S3 bucket is required');
    if (!String(config.accessKeyId || '').trim()) throw new Error('S3 access key is required');
    if (!String(config.secretAccessKey || '')) throw new Error('S3 secret key is required');
  }
}

function buildWebDavUrl(baseUrl: string, relativePath: string): string {
  // trimTrailingSlashes 用循环实现，避免 /\/+$/ 这种尾部量词命中 CodeQL js/polynomial-redos
  const trimmedBase = trimTrailingSlashes(baseUrl);
  const normalized = normalizeRelativePath(relativePath);
  return normalized ? `${trimmedBase}/${encodePathSegments(normalized)}` : trimmedBase;
}

function webDavFullPath(config: WebDavBackupDestination, relativePath: string): string {
  return buildJoinedPath(config.remotePath, normalizeRelativePath(relativePath));
}

async function ensureWebDavDirectory(
  baseUrl: string,
  directoryPath: string,
  authHeader: string,
  timeouts: RemoteRequestTimeouts
): Promise<void> {
  const segments = trimSlashes(directoryPath).split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = buildJoinedPath(current, segment);
    const url = buildWebDavUrl(baseUrl, current);
    const response = await withRemoteTimeout('WebDAV', 'directory creation', timeouts.controlMs, (signal) =>
      fetch(url, {
        method: 'MKCOL',
        headers: {
          Authorization: authHeader,
        },
        signal,
      })
    );
    if ([200, 201, 204, 405].includes(response.status)) continue;
    throw new Error(`WebDAV directory creation failed: ${response.status}`);
  }
}

async function ensureWebDavDirectoryCached(
  baseUrl: string,
  directoryPath: string,
  authHeader: string,
  ensuredDirectories: Set<string>,
  timeouts: RemoteRequestTimeouts
): Promise<void> {
  const segments = trimSlashes(directoryPath).split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = buildJoinedPath(current, segment);
    if (ensuredDirectories.has(current)) continue;
    const url = buildWebDavUrl(baseUrl, current);
    const response = await withRemoteTimeout('WebDAV', 'directory creation', timeouts.controlMs, (signal) =>
      fetch(url, {
        method: 'MKCOL',
        headers: {
          Authorization: authHeader,
        },
        signal,
      })
    );
    if ([200, 201, 204, 405].includes(response.status)) {
      ensuredDirectories.add(current);
      continue;
    }
    throw new Error(`WebDAV directory creation failed: ${response.status}`);
  }
}

async function putToWebDav(
  config: WebDavBackupDestination,
  relativePath: string,
  bytes: Uint8Array,
  options: RemoteBackupFilePutOptions = {},
  ensuredDirectories: Set<string> | undefined,
  timeouts: RemoteRequestTimeouts
): Promise<void> {
  const authHeader = toBasicAuthHeader(config.username, config.password);
  const remoteFilePath = buildJoinedPath(config.remotePath, relativePath);
  const remoteDir = parentPath(remoteFilePath);

  if (remoteDir) {
    if (ensuredDirectories) {
      await ensureWebDavDirectoryCached(config.baseUrl, remoteDir, authHeader, ensuredDirectories, timeouts);
    } else {
      await ensureWebDavDirectory(config.baseUrl, remoteDir, authHeader, timeouts);
    }
  }

  const response = await withRemoteTimeout(
    'WebDAV',
    'upload',
    resolveTransferTimeoutMs(bytes.byteLength, timeouts),
    (signal) =>
      fetch(buildWebDavUrl(config.baseUrl, remoteFilePath), {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': options.contentType || 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
        },
        body: bytes,
        signal,
      })
  );

  if (!response.ok) {
    throw new Error(`WebDAV upload failed: ${response.status}`);
  }
}

async function uploadToWebDav(
  config: WebDavBackupDestination,
  archive: Uint8Array,
  fileName: string,
  timeouts: RemoteRequestTimeouts
): Promise<BackupUploadResult> {
  await putToWebDav(config, fileName, archive, { contentType: 'application/zip' }, undefined, timeouts);
  return {
    provider: 'webdav',
    remotePath: buildJoinedPath(config.remotePath, fileName),
  };
}

function parseWebDavResponsePath(baseUrl: string, href: string): string {
  const base = new URL(baseUrl);
  const target = new URL(href, base);
  const basePath = trimSlashes(decodeURIComponent(base.pathname));
  const entryPath = trimSlashes(decodeURIComponent(target.pathname));
  if (!basePath) return entryPath;
  if (entryPath === basePath) return '';
  return entryPath.startsWith(`${basePath}/`) ? entryPath.slice(basePath.length + 1) : entryPath;
}

async function listWebDavEntries(
  config: WebDavBackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<RemoteBackupListResult> {
  const currentPath = normalizeRelativePath(relativePath);
  const targetFullPath = webDavFullPath(config, currentPath);
  const authHeader = toBasicAuthHeader(config.username, config.password);
  // 列目录的响应体很小，把「请求 + 读 body」放在同一段预算里即可
  const listing = await withRemoteTimeout('WebDAV', 'listing', timeouts.listingMs, async (signal) => {
    const response = await fetch(buildWebDavUrl(config.baseUrl, targetFullPath), {
      method: 'PROPFIND',
      headers: {
        Authorization: authHeader,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>`,
      signal,
    });
    if (response.status === 404) {
      return { missing: true as const, xml: '' };
    }
    if (!response.ok) {
      throw new Error(`WebDAV listing failed: ${response.status}`);
    }
    return { missing: false as const, xml: await response.text() };
  });
  if (listing.missing) {
    return {
      provider: 'webdav',
      currentPath,
      parentPath: parentPath(currentPath),
      items: [],
    };
  }

  const xml = listing.xml;
  const rootFullPath = trimSlashes(config.remotePath);
  const items: RemoteBackupItem[] = [];
  for (const block of extractXmlBlocks(xml, 'response')) {
    const href = extractXmlFirst(block, 'href');
    if (!href) continue;
    const fullPath = trimSlashes(parseWebDavResponsePath(config.baseUrl, href));
    if (!fullPath) continue;
    if (fullPath === targetFullPath) continue;
    if (rootFullPath && !(fullPath === rootFullPath || fullPath.startsWith(`${rootFullPath}/`))) continue;
    const relative = rootFullPath
      ? fullPath === rootFullPath
        ? ''
        : fullPath.slice(rootFullPath.length + 1)
      : fullPath;
    if (!relative) continue;
    const directParent = parentPath(relative);
    if ((directParent || '') !== currentPath) continue;

    const resourceTypeBlock = extractXmlFirst(block, 'resourcetype') || '';
    const isDirectory = /<(?:[^:>]+:)?collection\b/i.test(resourceTypeBlock);
    const sizeRaw = extractXmlFirst(block, 'getcontentlength');
    const modifiedAtRaw = extractXmlFirst(block, 'getlastmodified');
    items.push({
      path: relative,
      name: basename(relative) || relative,
      isDirectory,
      size: !isDirectory && sizeRaw && Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : null,
      modifiedAt: modifiedAtRaw ? parseHttpDate(modifiedAtRaw) : null,
    });
  }

  return {
    provider: 'webdav',
    currentPath,
    parentPath: parentPath(currentPath),
    items: sortRemoteItems(items),
  };
}

async function downloadFromWebDav(
  config: WebDavBackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<RemoteBackupFile> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.endsWith('/')) {
    throw new Error('Please select a backup file');
  }
  const authHeader = toBasicAuthHeader(config.username, config.password);
  const remotePath = webDavFullPath(config, normalized);
  // 两段计时：先给“首包”，再按 Content-Length 给 body 预算。
  // 复用同一个 controller ⇒ 响应头已到达后 abort 仍能中断后面的 body 读取。
  const controller = new AbortController();
  const response = await withRemoteTimeout(
    'WebDAV',
    'download',
    timeouts.firstByteMs,
    (signal) =>
      fetch(buildWebDavUrl(config.baseUrl, remotePath), {
        method: 'GET',
        headers: {
          Authorization: authHeader,
        },
        signal,
      }),
    controller
  );
  if (!response.ok) {
    throw new Error(`WebDAV download failed: ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('Content-Length') || '');
  const bytes = await withRemoteTimeout(
    'WebDAV',
    'download',
    resolveTransferTimeoutMs(Number.isFinite(declaredLength) ? declaredLength : undefined, timeouts),
    () => response.arrayBuffer(),
    controller
  );
  return {
    provider: 'webdav',
    remotePath: normalized,
    fileName: basename(normalized) || 'backup.zip',
    contentType: String(response.headers.get('Content-Type') || 'application/zip').trim() || 'application/zip',
    bytes: new Uint8Array(bytes),
  };
}

async function deleteFromWebDav(
  config: WebDavBackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<void> {
  const authHeader = toBasicAuthHeader(config.username, config.password);
  const remotePath = webDavFullPath(config, relativePath);
  const response = await withRemoteTimeout('WebDAV', 'delete', timeouts.controlMs, (signal) =>
    fetch(buildWebDavUrl(config.baseUrl, remotePath), {
      method: 'DELETE',
      headers: {
        Authorization: authHeader,
      },
      signal,
    })
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`WebDAV delete failed: ${response.status}`);
  }
}

async function existsInWebDav(
  config: WebDavBackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<boolean> {
  return (await statWebDavFile(config, relativePath, timeouts)) !== null;
}

async function statWebDavFile(
  config: WebDavBackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<RemoteBackupFileStat | null> {
  const authHeader = toBasicAuthHeader(config.username, config.password);
  const remotePath = webDavFullPath(config, relativePath);
  const response = await withRemoteTimeout('WebDAV', 'existence check', timeouts.controlMs, (signal) =>
    fetch(buildWebDavUrl(config.baseUrl, remotePath), {
      method: 'HEAD',
      headers: {
        Authorization: authHeader,
      },
      signal,
    })
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`WebDAV existence check failed: ${response.status}`);
  }
  const size = Number(response.headers.get('Content-Length') || '');
  return {
    provider: 'webdav',
    remotePath: normalizeRelativePath(relativePath),
    size: Number.isFinite(size) ? size : null,
    modifiedAt: parseHttpDate(response.headers.get('Last-Modified') || ''),
  };
}

function isBucketHostedS3Endpoint(endpoint: URL, bucket: string): boolean {
  const hostname = endpoint.hostname.toLowerCase();
  const bucketName = bucket.trim().toLowerCase();
  return !!bucketName && (hostname === bucketName || hostname.startsWith(`${bucketName}.`));
}

function s3BucketBaseUrl(config: S3BackupDestination): URL {
  const endpoint = new URL(trimTrailingSlashes(config.endpoint));
  const bucket = config.bucket.trim();

  if (config.addressingStyle === 'virtual-hosted-style') {
    if (isBucketHostedS3Endpoint(endpoint, bucket)) return endpoint;
    endpoint.hostname = `${bucket}.${endpoint.hostname}`;
    return endpoint;
  }

  return new URL(`${trimTrailingSlashes(endpoint.toString())}/${encodeURIComponent(bucket)}`);
}

function s3ObjectUrl(config: S3BackupDestination, objectKey: string): URL {
  return new URL(`${trimTrailingSlashes(s3BucketBaseUrl(config).toString())}/${encodePathSegments(objectKey)}`);
}

function normalizeS3ObjectKey(config: S3BackupDestination, relativePath: string): string {
  return buildJoinedPath(config.rootPath, normalizeRelativePath(relativePath));
}

async function signedS3Request(
  config: S3BackupDestination,
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  url: URL,
  signal: AbortSignal,
  body?: Uint8Array,
  contentType?: string
): Promise<Response> {
  const payloadHashHex = await sha256Hex(body || new Uint8Array());
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHashHex,
    'x-amz-date': amzDate,
  };
  if (method === 'PUT') headers['content-type'] = contentType || 'application/octet-stream';

  const authorization = await buildAwsV4Authorization(
    method,
    url,
    headers,
    payloadHashHex,
    config.accessKeyId,
    config.secretAccessKey,
    config.region || 'auto'
  );

  return fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'X-Amz-Content-Sha256': headers['x-amz-content-sha256'],
      'X-Amz-Date': headers['x-amz-date'],
      ...(method === 'PUT' ? { 'Content-Type': headers['content-type'] } : {}),
    },
    body,
    signal,
  });
}

async function putToS3(
  config: S3BackupDestination,
  relativePath: string,
  bytes: Uint8Array,
  options: RemoteBackupFilePutOptions,
  timeouts: RemoteRequestTimeouts
): Promise<void> {
  const objectKey = normalizeS3ObjectKey(config, relativePath);
  const url = s3ObjectUrl(config, objectKey);
  const response = await withRemoteTimeout(
    'S3',
    'upload',
    resolveTransferTimeoutMs(bytes.byteLength, timeouts),
    (signal) => signedS3Request(config, 'PUT', url, signal, bytes, options.contentType)
  );

  if (!response.ok) {
    throw new Error(`S3 upload failed: ${response.status}`);
  }
}

async function uploadToS3(
  config: S3BackupDestination,
  archive: Uint8Array,
  fileName: string,
  timeouts: RemoteRequestTimeouts
): Promise<BackupUploadResult> {
  await putToS3(config, fileName, archive, { contentType: 'application/zip' }, timeouts);
  return {
    provider: 's3',
    remotePath: normalizeS3ObjectKey(config, fileName),
  };
}

async function listS3Entries(
  config: S3BackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<RemoteBackupListResult> {
  const currentPath = normalizeRelativePath(relativePath);
  const targetPrefixBase = normalizeS3ObjectKey(config, currentPath);
  const targetPrefix = trimSlashes(targetPrefixBase) ? `${trimSlashes(targetPrefixBase)}/` : '';
  const rootPrefix = trimSlashes(config.rootPath);
  const items: RemoteBackupItem[] = [];
  let continuationToken = '';

  do {
    const url = s3BucketBaseUrl(config);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('delimiter', '/');
    if (targetPrefix) url.searchParams.set('prefix', targetPrefix);
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

    const xml = await withRemoteTimeout('S3', 'listing', timeouts.listingMs, async (signal) => {
      const response = await signedS3Request(config, 'GET', url, signal);
      if (!response.ok) {
        throw new Error(`S3 listing failed: ${response.status}`);
      }
      return response.text();
    });

    for (const prefix of extractXmlBlocks(xml, 'CommonPrefixes')) {
      const fullPrefix = trimSlashes(extractXmlFirst(prefix, 'Prefix') || '');
      if (!fullPrefix) continue;
      const relative = rootPrefix
        ? fullPrefix === rootPrefix
          ? ''
          : fullPrefix.startsWith(`${rootPrefix}/`)
            ? fullPrefix.slice(rootPrefix.length + 1)
            : ''
        : fullPrefix;
      const normalizedRelative = trimSlashes(relative);
      if (!normalizedRelative) continue;
      const itemPath = trimTrailingSlashes(normalizedRelative);
      if ((parentPath(itemPath) || '') !== currentPath) continue;
      items.push({
        path: itemPath,
        name: basename(itemPath) || itemPath,
        isDirectory: true,
        size: null,
        modifiedAt: null,
      });
    }

    for (const content of extractXmlBlocks(xml, 'Contents')) {
      const fullKey = trimSlashes(extractXmlFirst(content, 'Key') || '');
      if (!fullKey || (targetPrefix && fullKey === trimSlashes(targetPrefix))) continue;
      const relative = rootPrefix
        ? fullKey.startsWith(`${rootPrefix}/`)
          ? fullKey.slice(rootPrefix.length + 1)
          : ''
        : fullKey;
      const normalizedRelative = trimSlashes(relative);
      if (!normalizedRelative || (parentPath(normalizedRelative) || '') !== currentPath) continue;
      items.push({
        path: normalizedRelative,
        name: basename(normalizedRelative) || normalizedRelative,
        isDirectory: false,
        size: Number(extractXmlFirst(content, 'Size') || 0) || null,
        modifiedAt: parseHttpDate(extractXmlFirst(content, 'LastModified') || '') || null,
      });
    }

    continuationToken = extractXmlFirst(xml, 'NextContinuationToken') || '';
  } while (continuationToken);

  const deduped = new Map<string, RemoteBackupItem>();
  for (const item of items) deduped.set(`${item.isDirectory ? 'd' : 'f'}:${item.path}`, item);

  return {
    provider: 's3',
    currentPath,
    parentPath: parentPath(currentPath),
    items: sortRemoteItems(Array.from(deduped.values())),
  };
}

async function downloadFromS3(
  config: S3BackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<RemoteBackupFile> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.endsWith('/')) {
    throw new Error('Please select a backup file');
  }
  const objectKey = normalizeS3ObjectKey(config, normalized);
  const url = s3ObjectUrl(config, objectKey);
  // 与 WebDAV 下载同构：先给“首包”，再按 Content-Length 给 body 预算，复用同一 controller
  const controller = new AbortController();
  const response = await withRemoteTimeout(
    'S3',
    'download',
    timeouts.firstByteMs,
    (signal) => signedS3Request(config, 'GET', url, signal),
    controller
  );
  if (!response.ok) {
    throw new Error(`S3 download failed: ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('Content-Length') || '');
  const bytes = await withRemoteTimeout(
    'S3',
    'download',
    resolveTransferTimeoutMs(Number.isFinite(declaredLength) ? declaredLength : undefined, timeouts),
    () => response.arrayBuffer(),
    controller
  );
  return {
    provider: 's3',
    remotePath: normalized,
    fileName: basename(normalized) || 'backup.zip',
    contentType: String(response.headers.get('Content-Type') || 'application/zip').trim() || 'application/zip',
    bytes: new Uint8Array(bytes),
  };
}

async function deleteFromS3(
  config: S3BackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<void> {
  const objectKey = normalizeS3ObjectKey(config, relativePath);
  const url = s3ObjectUrl(config, objectKey);
  const response = await withRemoteTimeout('S3', 'delete', timeouts.controlMs, (signal) =>
    signedS3Request(config, 'DELETE', url, signal)
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`S3 delete failed: ${response.status}`);
  }
}

async function existsInS3(
  config: S3BackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<boolean> {
  return (await statS3File(config, relativePath, timeouts)) !== null;
}

async function statS3File(
  config: S3BackupDestination,
  relativePath: string,
  timeouts: RemoteRequestTimeouts
): Promise<RemoteBackupFileStat | null> {
  const objectKey = normalizeS3ObjectKey(config, relativePath);
  const url = s3ObjectUrl(config, objectKey);
  const response = await withRemoteTimeout('S3', 'existence check', timeouts.controlMs, (signal) =>
    signedS3Request(config, 'HEAD', url, signal)
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`S3 existence check failed: ${response.status}`);
  }
  const size = Number(response.headers.get('Content-Length') || '');
  return {
    provider: 's3',
    remotePath: normalizeRelativePath(relativePath),
    size: Number.isFinite(size) ? size : null,
    modifiedAt: parseHttpDate(response.headers.get('Last-Modified') || ''),
  };
}

interface ConfiguredDestinationAdapter {
  provider: 'webdav' | 's3';
  config: WebDavBackupDestination | S3BackupDestination;
  upload: (config: WebDavBackupDestination | S3BackupDestination, archive: Uint8Array, fileName: string) => Promise<BackupUploadResult>;
  putFile: (config: WebDavBackupDestination | S3BackupDestination, relativePath: string, bytes: Uint8Array, options?: RemoteBackupFilePutOptions) => Promise<void>;
  list: (config: WebDavBackupDestination | S3BackupDestination, relativePath: string) => Promise<RemoteBackupListResult>;
  download: (config: WebDavBackupDestination | S3BackupDestination, relativePath: string) => Promise<RemoteBackupFile>;
  deleteFile: (config: WebDavBackupDestination | S3BackupDestination, relativePath: string) => Promise<void>;
  exists: (config: WebDavBackupDestination | S3BackupDestination, relativePath: string) => Promise<boolean>;
  stat: (config: WebDavBackupDestination | S3BackupDestination, relativePath: string) => Promise<RemoteBackupFileStat | null>;
}

export interface RemoteBackupTransferSession {
  provider: BackupDestinationType;
  uploadArchive(archive: Uint8Array, fileName: string): Promise<BackupUploadResult>;
  putFile(relativePath: string, bytes: Uint8Array, options?: RemoteBackupFilePutOptions): Promise<void>;
  list(relativePath: string): Promise<RemoteBackupListResult>;
  download(relativePath: string): Promise<RemoteBackupFile>;
  deleteFile(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<RemoteBackupFileStat | null>;
}

function resolveConfiguredDestinationAdapter(
  destination: BackupDestinationRecord,
  timeouts: RemoteRequestTimeouts
): ConfiguredDestinationAdapter {
  ensureDestinationConfigReady(destination);

  if (destination.type === 'webdav') {
    return {
      provider: 'webdav',
      config: destination.destination as WebDavBackupDestination,
      upload: (config, archive, fileName) => uploadToWebDav(config as WebDavBackupDestination, archive, fileName, timeouts),
      putFile: (config, relativePath, bytes, options) => putToWebDav(config as WebDavBackupDestination, relativePath, bytes, options ?? {}, undefined, timeouts),
      list: (config, relativePath) => listWebDavEntries(config as WebDavBackupDestination, relativePath, timeouts),
      download: (config, relativePath) => downloadFromWebDav(config as WebDavBackupDestination, relativePath, timeouts),
      deleteFile: (config, relativePath) => deleteFromWebDav(config as WebDavBackupDestination, relativePath, timeouts),
      exists: (config, relativePath) => existsInWebDav(config as WebDavBackupDestination, relativePath, timeouts),
      stat: (config, relativePath) => statWebDavFile(config as WebDavBackupDestination, relativePath, timeouts),
    };
  }
  if (destination.type === 's3') {
    return {
      provider: 's3',
      config: destination.destination as S3BackupDestination,
      upload: (config, archive, fileName) => uploadToS3(config as S3BackupDestination, archive, fileName, timeouts),
      putFile: (config, relativePath, bytes, options) => putToS3(config as S3BackupDestination, relativePath, bytes, options ?? {}, timeouts),
      list: (config, relativePath) => listS3Entries(config as S3BackupDestination, relativePath, timeouts),
      download: (config, relativePath) => downloadFromS3(config as S3BackupDestination, relativePath, timeouts),
      deleteFile: (config, relativePath) => deleteFromS3(config as S3BackupDestination, relativePath, timeouts),
      exists: (config, relativePath) => existsInS3(config as S3BackupDestination, relativePath, timeouts),
      stat: (config, relativePath) => statS3File(config as S3BackupDestination, relativePath, timeouts),
    };
  }

  throw new Error('Unsupported backup destination type');
}

/**
 * @param timeouts 仅供测试注入更小的值，避免单测真的等 5–30 秒；生产代码不要传。
 */
export function createRemoteBackupTransferSession(
  destination: BackupDestinationRecord,
  timeouts?: Partial<RemoteRequestTimeouts>
): RemoteBackupTransferSession {
  const resolvedTimeouts = resolveRemoteRequestTimeouts(timeouts);
  const adapter = resolveConfiguredDestinationAdapter(destination, resolvedTimeouts);
  const ensuredDirectories = adapter.provider === 'webdav' ? new Set<string>() : null;

  const putFile = async (relativePath: string, bytes: Uint8Array, options: RemoteBackupFilePutOptions = {}): Promise<void> => {
    const normalized = normalizeRelativePath(relativePath);
    if (adapter.provider === 'webdav' && ensuredDirectories) {
      await putToWebDav(
        adapter.config as WebDavBackupDestination,
        normalized,
        bytes,
        options,
        ensuredDirectories,
        resolvedTimeouts
      );
      return;
    }
    await adapter.putFile(adapter.config, normalized, bytes, options);
  };

  return {
    provider: adapter.provider,
    uploadArchive: async (archive: Uint8Array, fileName: string) => {
      await putFile(fileName, archive, { contentType: 'application/zip' });
      return {
        provider: adapter.provider,
        remotePath: adapter.provider === 'webdav'
          ? buildJoinedPath((adapter.config as WebDavBackupDestination).remotePath, fileName)
          : normalizeS3ObjectKey(adapter.config as S3BackupDestination, fileName),
      };
    },
    putFile,
    list: async (relativePath: string) => adapter.list(adapter.config, relativePath),
    download: async (relativePath: string) => adapter.download(adapter.config, relativePath),
    deleteFile: async (relativePath: string) => adapter.deleteFile(adapter.config, normalizeRelativePath(relativePath)),
    exists: async (relativePath: string) => adapter.exists(adapter.config, normalizeRelativePath(relativePath)),
    stat: async (relativePath: string) => adapter.stat(adapter.config, normalizeRelativePath(relativePath)),
  };
}

export async function uploadBackupArchive(
  destination: BackupDestinationRecord,
  archive: Uint8Array,
  fileName: string,
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<BackupUploadResult> {
  return createRemoteBackupTransferSession(destination, timeouts).uploadArchive(archive, fileName);
}

export async function listRemoteBackupEntries(
  destination: BackupDestinationRecord,
  relativePath: string,
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<RemoteBackupListResult> {
  return createRemoteBackupTransferSession(destination, timeouts).list(relativePath);
}

export async function downloadRemoteBackupFile(
  destination: BackupDestinationRecord,
  relativePath: string,
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<RemoteBackupFile> {
  return createRemoteBackupTransferSession(destination, timeouts).download(relativePath);
}

export async function deleteRemoteBackupFile(
  destination: BackupDestinationRecord,
  relativePath: string,
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<void> {
  const normalized = ensureRemoteRestoreCandidate(relativePath);
  await createRemoteBackupTransferSession(destination, timeouts).deleteFile(normalized);
}

export async function remoteBackupFileExists(
  destination: BackupDestinationRecord,
  relativePath: string,
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<boolean> {
  const normalized = normalizeRelativePath(relativePath);
  return createRemoteBackupTransferSession(destination, timeouts).exists(normalized);
}

export async function uploadRemoteBackupFile(
  destination: BackupDestinationRecord,
  relativePath: string,
  bytes: Uint8Array,
  options: RemoteBackupFilePutOptions = {},
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<void> {
  const normalized = normalizeRelativePath(relativePath);
  await createRemoteBackupTransferSession(destination, timeouts).putFile(normalized, bytes, options);
}

function compareBackupItemsByRecency(a: RemoteBackupItem, b: RemoteBackupItem, preferredFileName?: string): number {
  if (preferredFileName) {
    const aPreferred = a.name === preferredFileName ? 1 : 0;
    const bPreferred = b.name === preferredFileName ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
  }
  const aTime = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
  const bTime = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
  if (aTime !== bTime) return bTime - aTime;
  return b.name.localeCompare(a.name, 'en');
}

export async function pruneRemoteBackupArchives(
  destination: BackupDestinationRecord,
  retentionCount: number | null,
  preferredFileName?: string,
  timeouts?: Partial<RemoteRequestTimeouts>
): Promise<number> {
  if (retentionCount === null) return 0;
  const adapter = resolveConfiguredDestinationAdapter(destination, resolveRemoteRequestTimeouts(timeouts));
  const listing = await adapter.list(adapter.config, '');
  const backupFiles = listing.items
    .filter((item) => !item.isDirectory && isBackupArchiveName(item.name))
    .sort((a, b) => compareBackupItemsByRecency(a, b, preferredFileName));
  if (backupFiles.length <= retentionCount) return 0;
  for (const item of backupFiles.slice(retentionCount)) {
    await adapter.deleteFile(adapter.config, item.path);
  }
  return backupFiles.length - retentionCount;
}

export function ensureRemoteRestoreCandidate(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || !/\.zip$/i.test(normalized)) {
    throw new Error('Please select a backup ZIP file');
  }
  return normalized;
}

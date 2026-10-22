import { Env } from './types';
import { NotificationsHub } from './durable/notifications-hub';
import { BackupTransferRunner } from './durable/backup-transfer-runner';
import { handleRequest } from './router';
import { StorageService } from './services/storage';
import { safeWriteAuditEvent } from './services/audit-events';
import { trackAppVersionOnce } from './services/app-version-log';
import { purgeSecretsTrash } from './services/secrets-trash';
import { applyCors, jsonResponse } from './utils/response';
import { runScheduledBackupIfDue } from './handlers/backup';
import {
  isBackendRequestPath,
  isWebVaultHidden,
  webVaultNotFoundResponse,
} from './web-vault-visibility';
import { withStaticCacheHeaders } from './static-asset-cache';

let dbInitialized = false;
let dbInitError: string | null = null;
let dbInitPromise: Promise<void> | null = null;

/** 初始化要连做 17 次 D1 往返，任一次瞬态断连都会让整个请求 / 整轮 cron 报废。 */
const DB_INIT_ATTEMPTS = 3;
const DB_INIT_RETRY_DELAY_MS = 200;
/** 值得重试的失败：D1 连接被重置、DO 实例被换掉（只能看文本，没有稳定的 code）。 */
const TRANSIENT_DB_INIT_ERROR = /network connection lost|connection closed|no longer active|internal error/i;

function isTransientDbInitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TRANSIENT_DB_INIT_ERROR.test(message);
}

async function initializeDatabaseWithRetry(env: Env): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= DB_INIT_ATTEMPTS; attempt += 1) {
    try {
      await new StorageService(env.DB).initializeDatabase();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= DB_INIT_ATTEMPTS || !isTransientDbInitError(error)) break;
      console.warn(`Database initialization attempt ${attempt} failed (transient), retrying:`, error);
      // 极短的退避：只为错开同一瞬间的抖动，不占 CPU
      await new Promise((resolve) => setTimeout(resolve, DB_INIT_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function normalizeRequestUrl(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname) return request;

  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function addSearchIndexHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
  const shouldNoIndex =
    url.pathname === '/robots.txt' ||
    contentType.includes('text/html');

  if (!shouldNoIndex) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * `[assets] not_found_handling = "single-page-application"` 会把缺失的 `/assets/*` 也变成
 * `index.html` + `200 OK`，浏览器把它当 ES module 解析就会失败。这里还原成真 404。
 */
const ASSET_PATH_PREFIX = '/assets/';

async function maybeServeAsset(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (isBackendRequestPath(url.pathname)) return null;

  const response = await env.ASSETS.fetch(request);

  if (url.pathname.startsWith(ASSET_PATH_PREFIX) && response.status === 200) {
    const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  return addSearchIndexHeaders(request, withStaticCacheHeaders(url.pathname, response));
}

async function ensureDatabaseInitialized(env: Env): Promise<void> {
  if (dbInitialized) return;

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await initializeDatabaseWithRetry(env);
      dbInitialized = true;
      dbInitError = null;
    })()
      .catch((error: unknown) => {
        console.error('Failed to initialize database:', error);
        dbInitError = error instanceof Error ? error.message : 'Unknown database initialization error';
      })
      .finally(() => {
        dbInitPromise = null;
      });
  }

  await dbInitPromise;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const normalizedRequest = normalizeRequestUrl(request);
    const requestPath = new URL(normalizedRequest.url).pathname;

    if (isWebVaultHidden(env) && !isBackendRequestPath(requestPath)) {
      return webVaultNotFoundResponse(normalizedRequest);
    }

    const assetResponse = await maybeServeAsset(normalizedRequest, env);
    if (assetResponse) {
      return applyCors(normalizedRequest, assetResponse, env);
    }

    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      // Log full error server-side, return generic message to client.
      console.error('DB init error (not forwarded to client):', dbInitError);
      const resp = jsonResponse(
        {
          error: 'Database not initialized',
          error_description: 'Database initialization failed. Check server logs for details.',
          ErrorModel: {
            Message: 'Service temporarily unavailable',
            Object: 'error',
          },
        },
        500
      );
      return applyCors(normalizedRequest, resp, env);
    }

    // 版本启动记录：每个 isolate 只跑一次，放进 waitUntil 不占请求关键路径。
    // 挂在这里是为了「部署后立刻有访客就能立刻在日志中心看到」；
    // 零流量的情况由下面的 scheduled（每 5 分钟）兜底。
    ctx.waitUntil(trackAppVersionOnce(env));

    const resp = await handleRequest(normalizedRequest, env);
    return applyCors(normalizedRequest, resp, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void controller;
    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      console.error('Skipping scheduled tasks because DB init failed:', dbInitError);
      // 只写 console 的话，「整轮被跳过」在日志中心完全不可见 —— 而这一轮连带跳过了
      // 备份与 Trash 清理。尽力而为：DB 不可用时这条写入本身也可能失败。
      await safeWriteAuditEvent(env, {
        actorUserId: null,
        action: 'system.db.init.failed',
        category: 'system',
        level: 'error',
        targetType: 'system',
        metadata: { error: dbInitError },
      });
      return;
    }
    // 与请求路径共用同一个“每 isolate 一次”入口：部署后即使零流量，
    // 最迟 5 分钟内也会把新版本写进日志中心。
    ctx.waitUntil(trackAppVersionOnce(env));
    ctx.waitUntil(runScheduledBackupIfDue(env).catch((error) => {
      console.error('Scheduled backup failed:', error);
    }));
    // 机密管理器的 Trash：软删只是标记，不清就永久留库 —— 满 30 天在这里物理删除
    ctx.waitUntil(
      purgeSecretsTrash(env)
        .then((purged) => {
          if (purged > 0) console.log(`Purged ${purged} expired secret(s) from trash`);
        })
        .catch((error) => {
          console.error('Secrets trash purge failed:', error);
        })
    );
  },
};

export { NotificationsHub };
export { BackupTransferRunner };

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

type DbInitState = 'idle' | 'initializing' | 'ready';

// ⚠️ 只能存状态，不能存 promise：从 compat date 2024-10-14 起，promise 只能在创建它的那次
// 请求里 settle，创建者提前结束时其续期被丢弃、永不 settle ⇒ 模块级引用成死 promise，
// 该 isolate 之后每个请求与每轮 cron 都会报 “created by a request that has since ended”。
let dbInitState: DbInitState = 'idle';
let dbInitError: string | null = null;
let dbInitStartedAt = 0;

/** 初始化要连做 17 次 D1 往返，任一次瞬态断连都会让整个请求 / 整轮 cron 报废。 */
const DB_INIT_ATTEMPTS = 3;
const DB_INIT_RETRY_DELAY_MS = 200;
/** 等别的请求完成初始化时，在自己上下文里轮询的步长与上限。 */
const DB_INIT_POLL_MS = 50;
const DB_INIT_WAIT_MS = 10_000;
/** 停在 `initializing` 超过此时长 ⇒ 认为持有者已死（其续期被运行时丢弃），由本请求接管。 */
const DB_INIT_STALE_MS = 30_000;
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
      // ⚠️ 首参必须是字面量：模板字面量 + 额外参数会被 Semgrep
      // `unsafe-formatstring` 判为「注入格式说明符可伪造日志」。
      console.warn('Database initialization attempt failed (transient); retrying:', attempt, error);
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

/** 等别的请求完成初始化；返回是否已就绪。轮询而非 await 他人的 promise（理由见上方注释）。 */
async function waitForDbInit(): Promise<boolean> {
  const deadline = Date.now() + DB_INIT_WAIT_MS;
  while (dbInitState === 'initializing' && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, DB_INIT_POLL_MS));
  }
  return dbInitState === 'ready';
}

async function ensureDatabaseInitialized(env: Env): Promise<void> {
  if (dbInitState === 'ready') return;

  if (dbInitState === 'initializing' && Date.now() - dbInitStartedAt < DB_INIT_STALE_MS) {
    if (await waitForDbInit()) return;
    // 等超时 ⇒ 接管。并发接管只会多跑几遍幂等 DDL（executeSchemaStatement 吞掉 already exists）。
  }

  dbInitState = 'initializing';
  dbInitStartedAt = Date.now();
  try {
    await initializeDatabaseWithRetry(env);
    dbInitState = 'ready';
    dbInitError = null;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    dbInitError = error instanceof Error ? error.message : 'Unknown database initialization error';
    // 回到 idle：保留「下一个请求还能重试」的语义，状态也永不卡在 initializing。
    dbInitState = 'idle';
  }
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

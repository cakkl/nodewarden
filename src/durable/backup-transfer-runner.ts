import type { Env } from '../types';
import type { BackupDestinationRecord, BackupSettings } from '../services/backup-config';
import {
  backupSchedulerWindowMinutes,
  requireBackupDestination,
  hasBackupSlotBetween,
  isBackupDueNow,
  loadBackupSettings,
} from '../services/backup-config';
import {
  createRemoteBackupTransferSession,
  downloadRemoteBackupFile,
  ensureRemoteRestoreCandidate,
  isRemoteRequestTimeoutError,
  remoteRequestFailureStatus,
} from '../services/backup-uploader';
import { getBlobObject } from '../services/blob-store';
import { StorageService } from '../services/storage';
import { notifyUserBackupProgress, notifyUserBackupRestoreProgress } from './notifications-hub';
import {
  executeConfiguredBackup,
  importAndAuditRemoteBackupFile,
} from '../handlers/backup';
import { isSafeBackupAttachmentBlobName, verifyBackupArchiveFileNameChecksum } from '../services/backup-archive';
import { zipSync } from 'fflate';

const BACKUP_JOB_STATE_KEY = 'backup.job.state.v1';
const BACKUP_JOB_LEASE_MS = 10 * 60 * 1000;
const BACKUP_JOB_HEARTBEAT_MS = 30 * 1000;
/** 心跳断了这么久就认为持有者已死（实例被重置后 `finally` 没跑成）。 */
const BACKUP_JOB_STALE_MS = 3 * BACKUP_JOB_HEARTBEAT_MS;
/**
 * 失败后的重试退避。窗口放宽到 30~60 分钟后，若每次失败都立即重试，
 * 一小时内会刷出十几条失败记录；退避到 15 分钟既保证能补跑，又不刷屏。
 */
const BACKUP_RETRY_BACKOFF_MS = 15 * 60 * 1000;

interface BackupJobState {
  token: string;
  reason: string;
  acquiredAt: string;
  touchedAt: string;
  expiresAtMs: number;
}

interface RemoteAttachmentChunkRequest {
  destination: BackupDestinationRecord;
  attachments: Array<{
    blobName: string;
  }>;
}

interface RemoteAttachmentDownloadRequest {
  destination: BackupDestinationRecord;
  blobName?: string | null;
}

interface RemoteAttachmentBatchDownloadRequest {
  destination: BackupDestinationRecord;
  blobNames?: string[] | null;
}

interface ConfiguredBackupRunRequest {
  actorUserId?: string | null;
  auditMetadata?: Record<string, unknown> | null;
  destinationId?: string | null;
  targetDeviceIdentifier?: string | null;
  trigger?: 'manual' | 'scheduled';
}

interface RemoteBackupRestoreRequest {
  actorUserId?: string | null;
  allowChecksumMismatch?: boolean;
  auditMetadata?: Record<string, unknown> | null;
  destinationId?: string | null;
  path?: string | null;
  replaceExisting?: boolean;
  targetDeviceIdentifier?: string | null;
}

function badRequest(message: string, status: number = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** 计划备份一轮的结果体（无到期目的地时也用它，保持响应形状一致）。 */
function scheduledBackupCompleted(
  completed: number,
  failures: Array<{ destinationId: string; error: string }>,
  /** 收尾阶段遇到可忽略的错误（已完成的工作不受影响），仅作提示。 */
  warning?: string | null
): Response {
  return new Response(JSON.stringify({
    ok: true,
    completed,
    failed: failures.length,
    failures,
    warning: warning || null,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export class BackupTransferRunner {
  private lastHeartbeatAt = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
  }

  private async acquireJob(reason: string): Promise<string | null> {
    const nowMs = Date.now();
    const token = crypto.randomUUID();
    const nowIso = new Date(nowMs).toISOString();

    // 「读租约 → 判断 → 写租约」必须在同一个事务内完成。
    // 若写成 await get() 之后再 await put()，两个并发请求可能都读到「当前无租约」，
    // 于是双双拿到 token，导致两个备份同时运行 —— 而本 DO 的唯一职责就是阻止这件事。
    // 与 notifications-hub.ts 中 ws-token 的单次消费同构（那里也注明了必须放进事务）。
    const acquired = await this.state.storage.transaction(async (txn) => {
      const current = await txn.get<BackupJobState>(BACKUP_JOB_STATE_KEY);
      if (current?.expiresAtMs && current.expiresAtMs > nowMs) {
        // 租约仍在有效期内：只有「心跳已停」才说明持有者已死（活着的任务每 30 秒刷
        // `touchedAt`），否则一律让路。这样实例被重置后残留的租约 90 秒即可接管，
        // 不必干等 10 分钟 TTL。
        const touchedMs = Date.parse(current.touchedAt);
        const heartbeatFresh = Number.isFinite(touchedMs) && nowMs - touchedMs < BACKUP_JOB_STALE_MS;
        if (heartbeatFresh) return false;
        console.warn(
          `Backup lease taken over: holder "${current.reason}" has no heartbeat for ${Math.round((nowMs - touchedMs) / 1000)}s`
        );
      }
      await txn.put<BackupJobState>(BACKUP_JOB_STATE_KEY, {
        token,
        reason,
        acquiredAt: nowIso,
        touchedAt: nowIso,
        expiresAtMs: nowMs + BACKUP_JOB_LEASE_MS,
      });
      return true;
    });

    if (!acquired) return null;
    this.lastHeartbeatAt = 0;
    return token;
  }

  private async touchJob(token: string, force = false): Promise<void> {
    const nowMs = Date.now();
    if (!force && nowMs - this.lastHeartbeatAt < BACKUP_JOB_HEARTBEAT_MS) return;
    this.lastHeartbeatAt = nowMs;

    // 事务内比对 token 后再续期，避免用过期快照覆盖掉新持有者的租约。
    await this.state.storage.transaction(async (txn) => {
      const current = await txn.get<BackupJobState>(BACKUP_JOB_STATE_KEY);
      if (current?.token !== token) return;

      await txn.put<BackupJobState>(BACKUP_JOB_STATE_KEY, {
        ...current,
        touchedAt: new Date(nowMs).toISOString(),
        expiresAtMs: nowMs + BACKUP_JOB_LEASE_MS,
      });
    });
  }

  /**
   * 定时器式心跳，返回停止函数（会等在途写入落盘）。
   * ⚠️ 不能只靠业务阶段的 `touchJob()`：打包 / 整包上传 / 回读校验都是单次 `await`
   * （上传上限 10 分钟），中间没有插心跳的点，只按阶段刷会被「90s 无心跳即接管」误杀。
   */
  private startJobHeartbeat(token: string): () => Promise<void> {
    let pending: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      // 串行化 + 逐次 catch：一次瞬态失败不能让整条链停在 rejected 上，
      // 否则此后不再刷心跳，90 秒后会被误判为持有者已死。
      pending = pending
        .then(() => this.touchJob(token, true))
        .catch((error) => {
          console.warn('Backup lease heartbeat failed:', error);
        });
    }, BACKUP_JOB_HEARTBEAT_MS);
    return async () => {
      clearInterval(timer);
      // 等在途心跳落盘，避免响应返回后还有悬挂的存储事务
      await pending.catch((error) => {
        console.warn('Backup lease heartbeat failed:', error);
      });
    };
  }

  private async releaseJob(token: string): Promise<void> {
    // 必须在事务内「比对 token → 删除」：否则 A 依快照判断通过、delete() 会误删
    // B 新写的租约（A: get → B: acquire 覆盖 → A: delete）。
    // ⚠️ 尽力而为：走到这里备份已经跑完，抛异常会把成功变失败；TTL 与心跳接管是兜底。
    try {
      await this.state.storage.transaction(async (txn) => {
        const current = await txn.get<BackupJobState>(BACKUP_JOB_STATE_KEY);
        if (current?.token === token) {
          await txn.delete(BACKUP_JOB_STATE_KEY);
        }
      });
    } catch (error) {
      console.warn('Backup lease release failed; it will expire by TTL:', error);
    }
  }

  private async runConfiguredBackup(request: Request): Promise<Response> {
    let body: ConfiguredBackupRunRequest;
    try {
      body = await request.json<ConfiguredBackupRunRequest>();
    } catch {
      return badRequest('Backup run payload is invalid');
    }

    const trigger = body.trigger === 'scheduled' ? 'scheduled' : 'manual';
    const actorUserId = String(body.actorUserId || '').trim() || null;
    if (trigger === 'manual' && !actorUserId) {
      return badRequest('Manual backup run requires an actor');
    }

    const token = await this.acquireJob(`${trigger}:${actorUserId || 'system'}`);
    if (!token) {
      return badRequest('Another backup run is already in progress', 409);
    }
    const stopHeartbeat = this.startJobHeartbeat(token);

    try {
      await this.touchJob(token);
      const storage = new StorageService(this.env.DB);
      const progress = actorUserId
        ? async (event: {
          operation: 'backup-remote-run';
          step: string;
          fileName: string;
          stageTitle: string;
          stageDetail: string;
          done?: boolean;
          ok?: boolean;
          error?: string | null;
        }) => {
          await notifyUserBackupProgress(
            this.env,
            actorUserId,
            event,
            String(body.targetDeviceIdentifier || '').trim() || null
          );
        }
        : null;

      const result = await executeConfiguredBackup(
        this.env,
        storage,
        actorUserId,
        trigger,
        body.destinationId || null,
        () => this.touchJob(token),
        progress,
        body.auditMetadata || null
      );
      // 备份已成功并已落库；这句只为回填响应体，读失败不能把成功变成报错。
      let settings: BackupSettings | null = null;
      try {
        settings = await loadBackupSettings(storage, this.env, 'UTC');
      } catch (error) {
        console.warn('Backup settings reload after a successful run failed:', error);
      }

      return new Response(JSON.stringify({
        object: 'backup-runner-result',
        result,
        settings,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'Backup run failed', remoteRequestFailureStatus(error));
    } finally {
      await stopHeartbeat();
      await this.releaseJob(token);
    }
  }

  /** 上一轮刚失败过（且还在退避内）⇒ 这一轮不再重试，避免 60 分钟窗口里每 5 分钟刷一次。 */
  private isRetryBackoffActive(destination: BackupDestinationRecord, now: Date): boolean {
    if (!destination.runtime.lastErrorAt) return false;
    const lastErrorMs = Date.parse(destination.runtime.lastErrorAt);
    if (!Number.isFinite(lastErrorMs)) return false;
    return now.getTime() - lastErrorMs < BACKUP_RETRY_BACKOFF_MS;
  }

  /** 本轮该跑的目的地：已到点且该 slot 尚未成功，或在扫描期间刚跨过某个 slot。 */
  private dueDestinations(
    destinations: BackupDestinationRecord[],
    now: Date,
    scanStart: Date
  ): BackupDestinationRecord[] {
    return destinations.filter((destination) =>
      !this.isRetryBackoffActive(destination, now)
      && (
        isBackupDueNow(destination, now, backupSchedulerWindowMinutes(destination))
        || hasBackupSlotBetween(destination, scanStart, now)
      )
    );
  }

  private async runScheduledBackups(): Promise<Response> {
    const storage = new StorageService(this.env.DB);
    // ⚠️ 先只读预检、**再**抢租约：空转 tick（每天 287 个）不该写租约 —— 任一次被打断
    // 都会留下残留租约，让后续 tick 误报「已有任务占用租约」，还可能挡住该跑的那一次。
    const previewNow = new Date();
    const previewSettings = await loadBackupSettings(storage, this.env, 'UTC');
    if (!this.dueDestinations(previewSettings.destinations, previewNow, previewNow).length) {
      return scheduledBackupCompleted(0, []);
    }

    const token = await this.acquireJob('scheduled');
    if (!token) {
      return badRequest('Another backup run is already in progress', 409);
    }
    const stopHeartbeat = this.startJobHeartbeat(token);

    let completed = 0;
    const failures: Array<{ destinationId: string; error: string }> = [];
    let warning: string | null = null;
    try {
      await this.touchJob(token);
      let scanStartMs = Date.now();

      while (true) {
        await this.touchJob(token);
        let settings: BackupSettings;
        try {
          settings = await loadBackupSettings(storage, this.env, 'UTC');
        } catch (error) {
          // 已经跑过：成功/失败都已写进 runtime 与审计，读配置失败不该改写结论
          // （否则日志中心会先「计划远程备份成功」、紧接一条「计划备份失败」）。
          if (completed > 0 || failures.length > 0) {
            warning = error instanceof Error ? error.message : 'Backup settings could not be reloaded';
            break;
          }
          throw error;
        }
        const now = new Date();
        const dueDestinations = this.dueDestinations(settings.destinations, now, new Date(scanStartMs));

        if (!dueDestinations.length) {
          break;
        }

        scanStartMs = now.getTime();
        for (const destination of dueDestinations) {
          await this.touchJob(token);
          try {
            await executeConfiguredBackup(
              this.env,
              storage,
              null,
              'scheduled',
              destination.id,
              () => this.touchJob(token)
            );
            completed += 1;
          } catch (error) {
            failures.push({
              destinationId: destination.id,
              error: error instanceof Error ? error.message : 'Scheduled backup failed',
            });
          }
        }
      }

      return scheduledBackupCompleted(completed, failures, warning);
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'Scheduled backup failed', remoteRequestFailureStatus(error));
    } finally {
      await stopHeartbeat();
      await this.releaseJob(token);
    }
  }

  private async restoreRemoteBackup(request: Request): Promise<Response> {
    let body: RemoteBackupRestoreRequest;
    try {
      body = await request.json<RemoteBackupRestoreRequest>();
    } catch {
      return badRequest('Remote restore payload is invalid');
    }

    const actorUserId = String(body.actorUserId || '').trim() || null;
    if (!actorUserId) {
      return badRequest('Remote restore requires an actor');
    }

    const token = await this.acquireJob(`restore:${actorUserId}`);
    if (!token) {
      return badRequest('Another backup or restore run is already in progress', 409);
    }
    const stopHeartbeat = this.startJobHeartbeat(token);

    try {
      await this.touchJob(token);
      const storage = new StorageService(this.env.DB);
      const settings = await loadBackupSettings(storage, this.env, 'UTC');
      const destination = requireBackupDestination(settings, body.destinationId || null);
      const path = ensureRemoteRestoreCandidate(String(body.path || ''));
      const restoreFileNameFromPath = path.split('/').pop() || path;
      const targetDeviceIdentifier = String(body.targetDeviceIdentifier || '').trim() || null;
      const replaceExisting = !!body.replaceExisting;

      await notifyUserBackupRestoreProgress(
        this.env,
        actorUserId,
        {
          operation: 'backup-restore',
          source: 'remote',
          step: 'remote_fetch_archive',
          fileName: restoreFileNameFromPath,
          stageTitle: 'txt_backup_restore_progress_remote_fetch_title',
          stageDetail: 'txt_backup_restore_progress_remote_fetch_detail',
          replaceExisting,
        },
        targetDeviceIdentifier
      );

      const remoteFile = await downloadRemoteBackupFile(destination, path);
      const checksumOk = await verifyBackupArchiveFileNameChecksum(remoteFile.bytes, remoteFile.fileName || path);
      if (!checksumOk && !body.allowChecksumMismatch) {
        return badRequest('Remote backup file checksum does not match its filename');
      }

      const result = await importAndAuditRemoteBackupFile(
        this.env,
        storage,
        actorUserId,
        remoteFile,
        destination,
        path,
        replaceExisting,
        !checksumOk,
        body.auditMetadata || null,
        targetDeviceIdentifier,
        () => this.touchJob(token)
      );

      return new Response(JSON.stringify(result.result), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'Remote backup restore failed', remoteRequestFailureStatus(error));
    } finally {
      await stopHeartbeat();
      await this.releaseJob(token);
    }
  }

  async fetch(request: Request): Promise<Response> {
    // 兜底：任何逃逸出来的错误都必须变成**可读且状态正确**的响应。
    // 否则 DO 抛错会让平台返回通用 500（`internal error; reference = …`），管理员无法自助排查；
    // 而 500 还会被前端 `retryableRequest` 自动重试 3 次，把一次失败放大成三倍等待。
    try {
      return await this.route(request);
    } catch (error) {
      return badRequest(
        error instanceof Error ? error.message : 'Backup transfer request failed',
        remoteRequestFailureStatus(error)
      );
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') {
      return badRequest('Not found', 404);
    }

    if (url.pathname === '/internal/run-configured-backup') {
      return this.runConfiguredBackup(request);
    }

    if (url.pathname === '/internal/run-scheduled-backups') {
      return this.runScheduledBackups();
    }

    if (url.pathname === '/internal/restore-remote-backup') {
      return this.restoreRemoteBackup(request);
    }

    if (url.pathname === '/internal/download-remote-attachment') {
      let body: RemoteAttachmentDownloadRequest;
      try {
        body = await request.json<RemoteAttachmentDownloadRequest>();
      } catch {
        return badRequest('Remote attachment download payload is invalid');
      }
      const blobName = String(body?.blobName || '').trim();
      if (!body?.destination || !isSafeBackupAttachmentBlobName(blobName)) {
        return badRequest('Remote attachment download payload is invalid');
      }
      const file = await downloadRemoteBackupFile(body.destination, `attachments/${blobName}`).catch((error: unknown) => {
        // 远端超时说明目标整体不可用 ⇒ 让它冒泡到 fetch() 的兜底（可读的 4xx），
        // 而不是伪装成「附件不存在」；其余错误保持既有的「不存在」语义。
        if (isRemoteRequestTimeoutError(error)) throw error;
        return null;
      });
      if (!file) {
        return badRequest('Remote attachment not found', 404);
      }
      return new Response(file.bytes, {
        status: 200,
        headers: {
          'Content-Type': file.contentType || 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (url.pathname === '/internal/download-remote-attachment-batch') {
      let body: RemoteAttachmentBatchDownloadRequest;
      try {
        body = await request.json<RemoteAttachmentBatchDownloadRequest>();
      } catch {
        return badRequest('Remote attachment batch download payload is invalid');
      }
      const blobNames = Array.from(new Set(
        (Array.isArray(body?.blobNames) ? body.blobNames : [])
          .map((blobName) => String(blobName || '').trim())
          .filter(isSafeBackupAttachmentBlobName)
      ));
      if (!body?.destination || !blobNames.length || blobNames.length > 40) {
        return badRequest('Remote attachment batch download payload is invalid');
      }

      const encoder = new TextEncoder();
      const entries: Array<{ blobName: string; path: string }> = [];
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < blobNames.length; i += 1) {
        const blobName = blobNames[i];
        const file = await downloadRemoteBackupFile(body.destination, `attachments/${blobName}`).catch((error: unknown) => {
          // 同上；而且这里一批最多 40 个：逐个等满超时等于把等待时间乘以 40，
          // 所以第一个超时就结束整批，让错误变成一条可读的 4xx。
          if (isRemoteRequestTimeoutError(error)) throw error;
          return null;
        });
        if (!file) continue;
        const path = `files/${i}.bin`;
        entries.push({ blobName, path });
        files[path] = file.bytes;
      }
      files['manifest.json'] = encoder.encode(JSON.stringify({ version: 1, entries }));

      return new Response(zipSync(files), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (url.pathname !== '/internal/upload-attachment-chunk') {
      return badRequest('Not found', 404);
    }

    let body: RemoteAttachmentChunkRequest;
    try {
      body = await request.json<RemoteAttachmentChunkRequest>();
    } catch {
      return badRequest('Attachment chunk payload is invalid');
    }

    if (!body?.destination || !Array.isArray(body.attachments)) {
      return badRequest('Attachment chunk payload is invalid');
    }

    const remoteSession = createRemoteBackupTransferSession(body.destination);
    let uploaded = 0;

    // 刻意**不**在循环里 catch：每次 putFile 都有超时，而同一目标不可用时失败几乎必然重复 ——
    // 第一个超时就该让整批立刻结束（冒泡到 fetch() 的兜底），而不是把 18 个附件逐个等满超时。
    for (const attachment of body.attachments) {
      const blobName = String(attachment?.blobName || '').trim();
      if (!isSafeBackupAttachmentBlobName(blobName)) {
        return badRequest('Attachment chunk payload is invalid');
      }

      const object = await getBlobObject(this.env, blobName);
      if (!object) {
        return badRequest(`Attachment blob missing for ${blobName}`, 409);
      }

      const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
      await remoteSession.putFile(`attachments/${blobName}`, bytes, {
        contentType: object.contentType,
      });
      uploaded += 1;
    }

    return new Response(JSON.stringify({
      ok: true,
      uploaded,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}

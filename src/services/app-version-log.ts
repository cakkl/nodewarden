// 应用版本启动记录：新版本第一次跑起来时写一条审计事件（会出现在 Web 端日志中心）。
//
// 必须“判定”而不是每次冷启动都写：模块顶层代码在每个 isolate 冷启动都会执行，而 isolate 又随时销毁
// 重建 —— 不判定会把日志刷满。上次见到的版本存在 D1 的 config 表里，真的变了才写（「变了」含两种：
// APP_VERSION 变了，或版本号没变但重新构建部署，即 CF_VERSION_METADATA.id）。
//
// 并发安全：判定与写入合并成一条 SQL（claimConfigValue）。
//
// ⚠️ 改动作名或元数据字段时必须同步两处：① 日志中心的 i18n 键 `txt_log_action_<动作名>` /
// `txt_log_meta_<键名>`（10 个语言包都要补，否则 i18n:validate 失败）；② audit-events.ts 的
// ALLOWED_METADATA_KEYS —— 白名单外会被静默丢弃。

import { APP_VERSION } from '../../shared/app-version';
import type { Env } from '../types';
import { safeWriteAuditEvent } from './audit-events';
import { claimConfigValue, getConfigValue } from './storage-config-repo';

/** 存在 config 表里的键。它与日志保留策略无关：清空审计日志/保留期清理都不会动它。 */
export const APP_VERSION_CONFIG_KEY = 'app.version.last';
/** 日志中心里显示的动作名 */
export const APP_VERSION_ACTION = 'system.app.version.started';

export interface VersionRecord {
  version: string;
  deploymentId: string | null;
  deploymentTag: string | null;
  deployedAt: string | null;
}

let trackedInThisIsolate = false;
let trackPromise: Promise<void> | null = null;

function currentVersionRecord(env: Env): VersionRecord {
  const meta = env.CF_VERSION_METADATA;
  return {
    version: APP_VERSION,
    deploymentId: meta?.id ?? null,
    deploymentTag: meta?.tag ?? null,
    deployedAt: meta?.timestamp ?? null,
  };
}

/**
 * 解析 config 里存的值。
 * 兼容早期/异常写法：若存的不是 JSON 对象，就退化成"只知道版本号"。
 */
export function parseVersionRecord(raw: string | null): VersionRecord | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<VersionRecord> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string') {
      return {
        version: parsed.version,
        deploymentId: typeof parsed.deploymentId === 'string' ? parsed.deploymentId : null,
        deploymentTag: typeof parsed.deploymentTag === 'string' ? parsed.deploymentTag : null,
        deployedAt: typeof parsed.deployedAt === 'string' ? parsed.deployedAt : null,
      };
    }
  } catch {
    // 落到下面按裸版本号处理
  }

  return { version: raw, deploymentId: null, deploymentTag: null, deployedAt: null };
}

/** 是否算是"新的一次部署"（首次记录也算） */
export function isNewDeployment(previous: VersionRecord | null, current: VersionRecord): boolean {
  if (!previous) return true;
  if (previous.version !== current.version) return true;
  // 版本号没变，但 Cloudflare 给的 deployment id 变了 ⇒ 仅重新构建部署。
  // 拿不到 id 时（本地 dev / 测试）只能按版本号判断。
  return current.deploymentId !== null && previous.deploymentId !== current.deploymentId;
}

async function trackAppVersion(env: Env): Promise<void> {
  const previous = parseVersionRecord(await getConfigValue(env.DB, APP_VERSION_CONFIG_KEY));
  const current = currentVersionRecord(env);

  if (!isNewDeployment(previous, current)) return;

  // 原子认领：并发（多个 isolate 同时冷启动）时只有赢家拿到 true，
  // 于是日志中心里只会出现一条，不会因为竞态重复。
  if (!await claimConfigValue(env.DB, APP_VERSION_CONFIG_KEY, JSON.stringify(current))) return;

  const metadata: Record<string, unknown> = { version: current.version };
  if (previous) metadata.previousVersion = previous.version;
  if (current.deploymentId) metadata.deploymentId = current.deploymentId;
  if (current.deployedAt) metadata.deployedAt = current.deployedAt;

  await safeWriteAuditEvent(env, {
    // 系统事件：没有操作者，日志中心里 actor 显示为 "—"（与既有的
    // user.bootstrap.admin_promoted 一致）。
    actorUserId: null,
    action: APP_VERSION_ACTION,
    category: 'system',
    level: 'info',
    targetType: 'system',
    targetId: null,
    metadata,
  });

  // 双写一行到 console：实时排查时 wrangler tail 里也能直接看到。
  console.info('App version started', metadata);
}

/**
 * 每个 isolate 最多跑一次（模块级标志 + 共享 promise，与 ensureDatabaseInitialized 同款做法）。
 *
 * 失败只记 console、绝不抛出：版本记录属"锦上添花"，不能影响请求或定时任务。失败后在同个 isolate 内
 * 不再重试 —— 兜底交给每 5 分钟的 scheduled，它每次都是新 isolate，会重新走一遍。
 */
export function trackAppVersionOnce(env: Env): Promise<void> {
  if (trackedInThisIsolate) return Promise.resolve();

  if (!trackPromise) {
    trackPromise = trackAppVersion(env)
      .catch((error: unknown) => {
        console.error('Failed to record app version startup:', error);
      })
      .finally(() => {
        trackPromise = null;
        trackedInThisIsolate = true;
      });
  }

  return trackPromise;
}

/** 仅供测试：重置"本 isolate 已检查过"的标志（模拟全新 isolate） */
export function resetAppVersionTrackingForTests(): void {
  trackedInThisIsolate = false;
  trackPromise = null;
}

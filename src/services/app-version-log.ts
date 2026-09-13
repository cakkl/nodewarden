// 应用版本启动记录：把「新版本第一次跑起来」这件事写成一条审计事件，
// 于是它会出现在 Web 端的「日志中心」（webapp/src/components/LogCenterPage.tsx）里。
//
// 为什么必须"判定"而不是每次冷启动都写一条：
//   Workers 里模块顶层代码只在该 isolate 冷启动时执行一次，而 isolate 会随扩缩容
//   随时销毁重建。若每次冷启动都写，日志中心会被同一版本的重复条目刷满。
//   所以这里把「上次见到的版本」持久化在 D1 的 config 表里，真的变了才写。
//
// 两种"变了"都要认：
//   ① 版本号变了（shared/app-version.ts 的 APP_VERSION 被改，即发版）；
//   ② 版本号没变、只是重新构建部署了 —— 靠 Cloudflare 的版本元数据绑定
//      （CF_VERSION_METADATA.id）识别，它每次 build/deploy 都不同。
//
// 并发安全：判定与写入合并成一条 SQL（claimConfigValue），见该函数的注释。
//
// 日志中心的键位约定（改动作名或元数据字段时别漏）：
//   - 动作标签 = `txt_log_action_` + 动作名（非字母数字换成下划线）
//     `system.app.version.started` → `txt_log_action_system_app_version_started`
//   - 元数据标签 = `txt_log_meta_` + 键名（驼峰转下划线）
//     `previousVersion` → `txt_log_meta_previous_version`
//     缺键不会崩（页面会 humanize 回退成英文），但 10 个语言包必须同时补，
//     否则 `npm run i18n:validate` 的键对齐检查会失败。
//   - 元数据是**白名单制**：没登记进 audit-events.ts 的 ALLOWED_METADATA_KEYS 的键
//     会被静默丢弃，所以新增字段时必须同步补那边。

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
 * 失败只记 console、绝不抛出：版本记录属"锦上添花"，不能影响请求或定时任务。
 * 失败后在同个 isolate 内不再重试 —— 兜底交给每 5 分钟的 scheduled，
 * 它每次都是新的 isolate，会重新走一遍。
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

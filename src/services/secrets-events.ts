import type { SmPrincipal } from './secrets-access';
import { insertEvents, type SmEvent, type SmEventActorType } from './storage-secrets-events-repo';
import { generateUUID } from '../utils/uuid';

/**
 * 机密管理器的事件类型码。
 *
 * ⚠️ 一律用官方的**数字码**（§一.8）：将来接 Public API / 导出 CSV 不必再映射一次。
 * 官方没有给「改名 / 项目授权变更 / 令牌创建吊销」定义码，所以这几种操作暂不记录
 * —— 与其自造数字，不如先空着。
 */
export const SmEventType = {
  SecretRetrieved: 2100,
  SecretCreated: 2101,
  SecretEdited: 2102,
  SecretDeleted: 2103,
  SecretPermanentlyDeleted: 2104,
  SecretRestored: 2105,
  ProjectCreated: 2201,
  ProjectEdited: 2202,
  ProjectDeleted: 2203,
  ServiceAccountCreated: 2304,
  ServiceAccountDeleted: 2305,
} as const;

/** 事件的操作者。`machine_account` 时事件也归该账号（`actorId` 就是账号 id）。 */
interface SmEventActor {
  type: SmEventActorType;
  id: string;
  organizationId: string;
}

export function eventActorOf(principal: SmPrincipal): SmEventActor {
  return principal.kind === 'machine'
    ? { type: 'machine_account', id: principal.machineAccountId, organizationId: principal.organizationId }
    : { type: 'user', id: principal.userId, organizationId: principal.organizationId };
}

/** 事件的目标：机密事件给 `secretId`，项目事件给 `projectId`，对账号本身的事件给 `machineAccountId`。 */
interface SmEventTarget {
  secretId?: string;
  projectId?: string;
  machineAccountId?: string;
}

function clientIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;
}

/**
 * 记一组事件（**逐条**，照官方口径）。
 *
 * ⚠️ 调用点都在业务写入**之后**，所以审计失败不能把已经完成的操作变成 500 —— 那只会让
 * 客户端以为没成功。这里吞掉异常并打日志（与 `writeBootstrapAdminAuditEvent` 同处置）；
 * 「事件确实写进去了」这件事由测试来保证，而不是靠让请求失败。
 */
export async function recordSecretsEvents(options: {
  db: D1Database;
  request: Request;
  actor: SmEventActor;
  typeCode: number;
  targets: readonly SmEventTarget[];
}): Promise<void> {
  const { db, request, actor, typeCode, targets } = options;
  if (targets.length === 0) return;

  const ip = clientIp(request);
  const createdAt = new Date().toISOString();
  const events: SmEvent[] = targets.map((target) => ({
    id: generateUUID(),
    orgId: actor.organizationId,
    actorType: actor.type,
    actorId: actor.id,
    typeCode,
    secretId: target.secretId ?? null,
    projectId: target.projectId ?? null,
    // 机器账号自己操作 ⇒ 事件属于它；用户操作 ⇒ 只有「对某个账号的操作」才带 id
    machineAccountId: actor.type === 'machine_account' ? actor.id : target.machineAccountId ?? null,
    ip,
    createdAt,
  }));

  try {
    await insertEvents(db, events);
  } catch (error) {
    console.error('Failed to record secrets manager events (ignored):', error);
  }
}

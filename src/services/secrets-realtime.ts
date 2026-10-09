import { waitUntil } from 'cloudflare:workers';
import type { Env } from '../types';
import { notifyUserSecretsManagerUpdate } from '../durable/notifications-hub';
import { readActingDeviceIdentifier } from '../utils/device';
import { getOrganizationById } from './storage-secrets-repo';

/** 变了什么：机密 / 项目 / 回收站，还是机器账号 / 授权 / 令牌 —— 两张页面各自整页刷新。 */
export type SmRealtimeKind = 'secrets' | 'machine-accounts';

export interface SmChangeOptions {
  env: Env;
  request: Request;
  organizationId: string;
  kind: SmRealtimeKind;
  /** Web 会话这路直接给；程序侧（CLI / SDK）没有 ⇒ 留空，靠组织反查。 */
  userId?: string | null;
}

/**
 * 机密管理器写入成功后，让**同一个用户**的 Web 页面整页刷新（CLI / SDK 改完也看得到）。
 *
 * ⚠️ 必须 fire-and-forget（`waitUntil`）：通知失败不能把已经写完的业务变成 500。
 * ⚠️ 程序侧凭据只有 org id ⇒ 反查 `sm_organizations.owner_user_id`（隐式组织与用户 1:1）。
 * ⚠️ `contextId` 取 Web 端自报的**标签页**标识，不能退回设备标识：同设备两个标签页会互相挡掉。
 */
export function broadcastSecretsManagerChange(options: SmChangeOptions): void {
  const { env, request, organizationId, kind, userId } = options;
  // 「自己这个标签页改的」由 Web 端自报（SM 专用头）；CLI / 官方客户端没这个头 ⇒ 退回到设备标识，
  // 程序侧连设备标识也没有 ⇒ `null`（不抑制）。
  const contextId =
    String(request.headers.get('X-NodeWarden-Sm-Context-Id') || '').trim() ||
    readActingDeviceIdentifier(request);
  waitUntil(
    (async () => {
      const target = userId || (await getOrganizationById(env.DB, organizationId))?.ownerUserId || null;
      if (!target) return;
      notifyUserSecretsManagerUpdate(env, target, kind, new Date().toISOString(), contextId);
    })().catch((error) => {
      console.error('Failed to broadcast secrets manager change (ignored):', error);
    })
  );
}

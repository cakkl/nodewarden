import type { Env } from '../types';
import { verifyJWT } from '../utils/jwt';
import { getMachineAccount, listMachineAccountGrants, type SmMachineAccountGrant } from './storage-secrets-machine-repo';

/**
 * 机密管理器访问令牌（`bws` 用的那种）的 JWT 标记。
 *
 * 与用户访问令牌的用途隔离靠两件事：`sub` 是机器账号 id（查不到对应用户），以及这个标记
 * （永不可能等于真实 security stamp）。
 */
export const SECRETS_ACCESS_TOKEN_STAMP = 'sm.access-token';

/** 程序侧主体：一个机器账号，以及它对各 project 的授权。 */
export interface SmPrincipal {
  organizationId: string;
  machineAccountId: string;
  grants: SmMachineAccountGrant[];
}

/**
 * 解析 `Authorization: Bearer <SM JWT>`，得到程序侧主体；不是合法 SM 令牌则 `null`。
 *
 * ⚠️ 每次都**回查机器账号是否还存在**：删账号时级联删掉的是令牌行，而 JWT 自身在过期前
 * 仍然可验签 —— 不回查就会留下最长一小时的可用窗口。
 */
export async function resolveSecretsPrincipal(env: Env, authHeader: string | null): Promise<SmPrincipal | null> {
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;

  const payload = await verifyJWT(parts[1], env.JWT_SECRET);
  if (!payload || payload.sstamp !== SECRETS_ACCESS_TOKEN_STAMP) return null;

  const organizationId = payload.organization;
  if (typeof organizationId !== 'string' || !organizationId || !payload.sub) return null;

  const account = await getMachineAccount(env.DB, organizationId, payload.sub);
  if (!account) return null;

  return {
    organizationId,
    machineAccountId: account.id,
    grants: await listMachineAccountGrants(env.DB, account.id),
  };
}

/** 该主体对某 project 的权限；没有授权则 `null`（= 看不见这个 project）。 */
export function permissionForProject(principal: SmPrincipal, projectId: string): SmMachineAccountGrant['permission'] | null {
  return principal.grants.find((grant) => grant.projectId === projectId)?.permission ?? null;
}

import type { Env } from '../types';
import { verifyJWT } from '../utils/jwt';
import { getMachineAccount, listMachineAccountGrants, type SmMachineAccountGrant } from './storage-secrets-machine-repo';
import { getImplicitOrganization, getOrganizationOwnerStatus } from './storage-secrets-repo';

/**
 * 机密管理器访问令牌（`bws` 用的那种）的 JWT 标记。
 *
 * 与用户访问令牌的用途隔离靠两件事：`sub` 是机器账号 id（查不到对应用户），以及这个标记
 * （永不可能等于真实 security stamp）。
 */
export const SECRETS_ACCESS_TOKEN_STAMP = 'sm.access-token';

/** 一个 machine account 对某 project 的权限档位。 */
export type SmPermission = SmMachineAccountGrant['permission'];

/** 程序侧主体：一个机器账号，以及它对各 project 的授权。 */
interface SmMachinePrincipal {
  kind: 'machine';
  organizationId: string;
  machineAccountId: string;
  grants: SmMachineAccountGrant[];
}

/**
 * Web 会话主体：组织的 owner。
 *
 * ⚠️ 会话 JWT **不带** `organization`（组织是懒创建的，签发会话时它还不在），所以组织的
 * 唯一来源是按 `owner_user_id` 反查 —— 路径里的 orgId 必须与它相等。
 */
interface SmUserPrincipal {
  kind: 'user';
  organizationId: string;
  userId: string;
}

/**
 * 权限判定用的主体。两条认证路径（Web 会话 / 机器账号令牌）的差异**只在这一个类型**上，
 * 下游的可见性过滤完全共用 —— 否则「网页看得到、CLI 看不到」迟早出现。
 */
export type SmPrincipal = SmMachinePrincipal | SmUserPrincipal;

/**
 * SM 令牌的解析结果。
 *
 * 必须分三档：`none` 要**放行**（Web 会话走的正是那条路，不能在这里被 401 掉），
 * `invalid` 则必须由本模块拒掉 —— 否则「删掉机器账号后它已签发的 JWT 立刻失效」就只
 * 剩用户令牌闸门在兜底，而那道闸门与 SM 的用途隔离无关，不应替它承担这个约定。
 */
type SmTokenResolution =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'ok'; principal: SmMachinePrincipal };

/**
 * 解析 `Authorization: Bearer <SM JWT>`，得到程序侧主体。
 *
 * ⚠️ 每次都**回查机器账号是否还存在**：删账号时级联删掉的是令牌行，而 JWT 自身在过期前
 * 仍然可验签 —— 不回查就会留下最长一小时的可用窗口。属主被封禁同理，也必须当场拒掉。
 */
export async function resolveSecretsPrincipal(env: Env, authHeader: string | null): Promise<SmTokenResolution> {
  if (!authHeader) return { kind: 'none' };

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return { kind: 'none' };

  const payload = await verifyJWT(parts[1], env.JWT_SECRET);
  if (!payload || payload.sstamp !== SECRETS_ACCESS_TOKEN_STAMP) return { kind: 'none' };

  const organizationId = payload.organization;
  if (typeof organizationId !== 'string' || !organizationId || !payload.sub) return { kind: 'invalid' };

  const account = await getMachineAccount(env.DB, organizationId, payload.sub);
  if (!account) return { kind: 'invalid' };
  // 封禁属主 ⇒ 停掉他名下所有机器账号（自动化也不例外）
  if ((await getOrganizationOwnerStatus(env.DB, organizationId)) !== 'active') return { kind: 'invalid' };

  return {
    kind: 'ok',
    principal: {
      kind: 'machine',
      organizationId,
      machineAccountId: account.id,
      grants: await listMachineAccountGrants(env.DB, account.id),
    },
  };
}

/** Web 会话主体。用户还没有隐式组织时返回 `null`（此时没有任何 project / secret 可服务）。 */
export async function resolveSecretsUserPrincipal(env: Env, userId: string): Promise<SmUserPrincipal | null> {
  const organization = await getImplicitOrganization(env.DB, userId);
  if (!organization) return null;
  return { kind: 'user', organizationId: organization.id, userId };
}

/**
 * 该主体可见的 project；`null` = 组织内**全部**。
 *
 * owner 对所有 project 默认 read-write（§三.5 规则①）⇒ 用 `null` 表示「全部」，而不是先去
 * 查一遍组织的 project 列表：所有调用方取 project 时都已按 `principal.organizationId` 过滤，
 * 再查一次只是多一条查询。
 */
export function grantedProjectIds(principal: SmPrincipal): ReadonlySet<string> | null {
  return principal.kind === 'machine' ? new Set(principal.grants.map((grant) => grant.projectId)) : null;
}

/** 该主体可写的 project；`null` = 组织内全部（owner）。 */
export function writableProjectIds(principal: SmPrincipal): ReadonlySet<string> | null {
  if (principal.kind === 'user') return null;
  return new Set(
    principal.grants.filter((grant) => grant.permission === 'write').map((grant) => grant.projectId)
  );
}

/**
 * 该主体对某 project 的权限；没授权则 `null`（= 看不见这个 project）。
 *
 * ⚠️ 前提：调用方取的 project 已经按 `principal.organizationId` 过滤过 —— 对 owner 恒为
 * `write` 就是靠这个前提才成立。
 */
export function permissionForProject(principal: SmPrincipal, projectId: string): SmPermission | null {
  if (principal.kind === 'user') return 'write';
  return principal.grants.find((grant) => grant.projectId === projectId)?.permission ?? null;
}

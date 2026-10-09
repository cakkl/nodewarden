import type { Env } from '../types';
import {
  createMachineAccount,
  deleteMachineAccount,
  getMachineAccount,
  listMachineAccountGrants,
  listMachineAccounts,
  removeMachineAccountGrant,
  setMachineAccountGrant,
  type SmPermission,
} from '../services/storage-secrets-machine-repo';
import {
  createAccessToken,
  listAccessTokensByMachineAccount,
  revokeAccessToken,
  type SmAccessToken,
} from '../services/storage-secrets-token-repo';
import { ensureImplicitOrganization } from '../services/storage-secrets-repo';
import { getProject } from '../services/storage-secrets-project-repo';
import { generateUUID } from '../utils/uuid';
import { errorResponse, jsonResponse } from '../utils/response';
import { isEncString, isSecretHash, normalizeName, normalizeOptionalTimestamp } from './secrets-shared';

/**
 * 机器账号与访问令牌的 Web 会话端点。
 *
 * 这些端点**只服务自家 Web UI**（`bws` 不用它们，所以没有官方线格式的约束），因此路径与
 * 字段都可以按我们自己的喜好来 —— 但仍然**不碰** `/api/sync`，也不混进官方形态的
 * `/api/organizations/...`。
 *
 * ⚠️ 每个子路径都必须先确认目标机器账号属于**调用者自己的组织**，否则就是横向越权（IDOR）。
 * 统一由 `resolveOwnedMachineAccount` 把关，不要在分支里各写一遍。
 */

const MACHINE_ACCOUNTS_PATH = '/api/secrets/machine-accounts';
const MACHINE_ACCOUNT_PATTERN = /^\/api\/secrets\/machine-accounts\/([^/]+)$/;
const GRANTS_PATTERN = /^\/api\/secrets\/machine-accounts\/([^/]+)\/grants$/;
const GRANT_PATTERN = /^\/api\/secrets\/machine-accounts\/([^/]+)\/grants\/([^/]+)$/;
const TOKENS_PATTERN = /^\/api\/secrets\/machine-accounts\/([^/]+)\/tokens$/;
const TOKEN_PATTERN = /^\/api\/secrets\/tokens\/([^/]+)$/;

/** 对外表示：**绝不**返回 `secretHash`（虽然它不可逆，也没有必要外发）。 */
function tokenSummary(token: SmAccessToken): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
    object: 'accessToken',
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleSecretsMachineAccountRoute(
  request: Request,
  env: Env,
  userId: string,
  path: string,
  method: string
): Promise<Response | null> {
  // 权限边界：先解出调用者自己的隐式组织，后面所有查询都带上它
  const organization = await ensureImplicitOrganization(env.DB, userId);

  /** 只放行属于本组织的机器账号；否则回 404（不区分「不存在」与「不是你的」）。 */
  async function resolveOwnedMachineId(rawId: string): Promise<string | Response> {
    const id = decodeURIComponent(rawId);
    const account = await getMachineAccount(env.DB, organization.id, id);
    return account ? id : errorResponse('Machine account not found', 404);
  }

  if (path === MACHINE_ACCOUNTS_PATH) {
    if (method === 'GET') {
      const accounts = await listMachineAccounts(env.DB, organization.id);
      const withGrants = await Promise.all(
        accounts.map(async (account) => ({
          id: account.id,
          name: account.name,
          createdAt: account.createdAt,
          grants: await listMachineAccountGrants(env.DB, account.id),
          object: 'machineAccount',
        }))
      );
      return jsonResponse({ data: withGrants, object: 'list' });
    }

    if (method === 'POST') {
      const body = await readJsonBody(request);
      const name = normalizeName(body?.name);
      if (!name) return errorResponse('Machine account name is required', 400);
      const account = { id: generateUUID(), orgId: organization.id, name, createdAt: new Date().toISOString() };
      await createMachineAccount(env.DB, account);
      return jsonResponse({ id: account.id, name: account.name, createdAt: account.createdAt, object: 'machineAccount' });
    }

    return errorResponse('Method not allowed', 405);
  }

  const accountMatch = path.match(MACHINE_ACCOUNT_PATTERN);
  if (accountMatch) {
    const resolved = await resolveOwnedMachineId(accountMatch[1]);
    if (resolved instanceof Response) return resolved;

    if (method === 'DELETE') {
      // 授权与该账号名下的令牌由外键级联删除
      await deleteMachineAccount(env.DB, organization.id, resolved);
      return jsonResponse({ id: resolved, object: 'machineAccountDeleted' });
    }

    if (method === 'GET') {
      return jsonResponse({
        id: resolved,
        grants: await listMachineAccountGrants(env.DB, resolved),
        object: 'machineAccount',
      });
    }

    return errorResponse('Method not allowed', 405);
  }

  const grantsMatch = path.match(GRANTS_PATTERN);
  if (grantsMatch && method === 'PUT') {
    const resolved = await resolveOwnedMachineId(grantsMatch[1]);
    if (resolved instanceof Response) return resolved;

    const body = await readJsonBody(request);
    const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    const permission = body?.permission;
    if (!projectId || (permission !== 'read' && permission !== 'write')) {
      return errorResponse('projectId and permission (read|write) are required', 400);
    }

    // project 必须在**本组织**内：否则外键会以 500 的形式炸出来，而且等于允许引用别人的项目
    const project = await getProject(env.DB, organization.id, projectId);
    if (!project) return errorResponse('Project not found', 404);

    await setMachineAccountGrant(env.DB, resolved, projectId, permission as SmPermission);
    return jsonResponse({ machineAccountId: resolved, projectId, permission, object: 'machineAccountGrant' });
  }

  const grantMatch = path.match(GRANT_PATTERN);
  if (grantMatch) {
    const resolved = await resolveOwnedMachineId(grantMatch[1]);
    if (resolved instanceof Response) return resolved;

    if (method === 'DELETE') {
      await removeMachineAccountGrant(env.DB, resolved, decodeURIComponent(grantMatch[2]));
      return jsonResponse({ machineAccountId: resolved, projectId: decodeURIComponent(grantMatch[2]), object: 'machineAccountGrantDeleted' });
    }

    return errorResponse('Method not allowed', 405);
  }

  const tokensMatch = path.match(TOKENS_PATTERN);
  if (tokensMatch) {
    const resolved = await resolveOwnedMachineId(tokensMatch[1]);
    if (resolved instanceof Response) return resolved;

    if (method === 'GET') {
      const tokens = await listAccessTokensByMachineAccount(env.DB, resolved);
      return jsonResponse({ data: tokens.map(tokenSummary), object: 'list' });
    }

    if (method === 'POST') {
      const body = await readJsonBody(request);
      const name = normalizeName(body?.name, 120);
      const secretHash = body?.secretHash;
      const encryptedPayload = body?.encryptedPayload;
      const expiresAt = normalizeOptionalTimestamp(body?.expiresAt);

      if (!name || !isSecretHash(secretHash) || !isEncString(encryptedPayload, 4096) || expiresAt === undefined) {
        return errorResponse('name, secretHash, encryptedPayload and a valid expiresAt are required', 400);
      }

      const token: SmAccessToken = {
        id: generateUUID(),
        machineAccountId: resolved,
        orgId: organization.id,
        name,
        secretHash,
        encryptedPayload,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      await createAccessToken(env.DB, token);
      // ⚠️ 只回 id：明文令牌由客户端用「自己生成的密钥 + 这里回吐的 payload」拼装，服务端从未见过它
      return jsonResponse({ id: token.id, name: token.name, expiresAt: token.expiresAt, object: 'accessToken' });
    }

    return errorResponse('Method not allowed', 405);
  }

  const tokenMatch = path.match(TOKEN_PATTERN);
  if (tokenMatch && method === 'DELETE') {
    const tokenId = decodeURIComponent(tokenMatch[1]);
    await revokeAccessToken(env.DB, tokenId, organization.id, new Date().toISOString());
    return jsonResponse({ id: tokenId, object: 'accessTokenRevoked' });
  }

  return null;
}

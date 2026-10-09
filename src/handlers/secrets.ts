import type { Env } from '../types';
import { ensureImplicitOrganization, getImplicitOrganization, getOrgKey, saveOrgKey } from '../services/storage-secrets-repo';
import { errorResponse, jsonResponse } from '../utils/response';
import { isEncString } from './secrets-shared';

/**
 * 机密管理器的 Web 会话端点。
 *
 * 组织是**隐式**的：客户端无从指定组织 id，第一次访问时由服务端创建。组织密钥由
 * 客户端生成、用密码库密钥包裹后上传 —— 服务端只存密文。
 *
 * 程序侧（access token）端点不在此，见 `/api/tokens/*` 与官方形态的 `/api/organizations/...`。
 */

/** 包裹后的组织密钥只有几百字节；上限防的是「拿超大字符串撑着行」。 */
const MAX_WRAPPED_ORG_KEY_LENGTH = 1024;

// GET /api/secrets/organization
export async function handleGetSecretsOrganization(_request: Request, env: Env, userId: string): Promise<Response> {
  const organization = await ensureImplicitOrganization(env.DB, userId);
  return jsonResponse({ id: organization.id, object: 'organization' });
}

// GET /api/secrets/organization-key
export async function handleGetSecretsOrganizationKey(_request: Request, env: Env, userId: string): Promise<Response> {
  const organization = await getImplicitOrganization(env.DB, userId);
  if (!organization) return jsonResponse({ wrappedOrgKey: null, object: 'organizationKey' });

  const orgKey = await getOrgKey(env.DB, organization.id, userId);
  return jsonResponse({ wrappedOrgKey: orgKey ? orgKey.wrappedOrgKey : null, object: 'organizationKey' });
}

// PUT /api/secrets/organization-key
export async function handlePutSecretsOrganizationKey(request: Request, env: Env, userId: string): Promise<Response> {
  let body: { wrappedOrgKey?: unknown };
  try {
    body = (await request.json()) as { wrappedOrgKey?: unknown };
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const wrappedOrgKey = typeof body.wrappedOrgKey === 'string' ? body.wrappedOrgKey.trim() : '';
  if (!isEncString(wrappedOrgKey, MAX_WRAPPED_ORG_KEY_LENGTH)) {
    return errorResponse('wrappedOrgKey must be an EncString of type 2', 400);
  }

  const organization = await ensureImplicitOrganization(env.DB, userId);
  await saveOrgKey(env.DB, organization.id, userId, wrappedOrgKey);
  return jsonResponse({ id: organization.id, object: 'organization' });
}

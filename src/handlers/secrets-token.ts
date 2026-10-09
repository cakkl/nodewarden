import type { Env } from '../types';
import { LIMITS } from '../config/limits';
import { getAccessTokenById, touchAccessTokenLastUsed } from '../services/storage-secrets-token-repo';
import { verifyApiKey } from '../utils/api-key';
import { createJWT } from '../utils/jwt';
import { identityErrorResponse, jsonResponse } from '../utils/response';

/**
 * 机密管理器的**程序取用**入口：`/identity/connect/token` 里 `client_credentials` 的
 * `scope=api.secrets` 一支（与官方 API key 登录共用同一个 grant，靠 scope 区分）。
 *
 * 线格式：请求 `client_id=<令牌 id>` + `client_secret=<令牌密钥>`；响应除 access token 外
 * 还要**原样回吐 `encrypted_payload`** —— 客户端用令牌密钥自己解出组织密钥，服务端不参与。
 */

/**
 * SM 令牌的 `sstamp` 标记。
 *
 * ⚠️ 这是**刻意的用途隔离**：SM 令牌的 `sub` 是机器账号 id，而 `verifyAccessTokenWithUser`
 * 会把 `sub` 当用户 id 去查、再比对 security stamp。用一个永不可能等于真实 security stamp
 * 的常量，等于给「SM 令牌不得用于普通端点」加了第二道锁（第一道是查不到对应用户）。
 */
export const SECRETS_ACCESS_TOKEN_STAMP = 'sm.access-token';

/** 参数不合法（缺 id / 缺密钥）——与官方那套 API key 登录同形。 */
function invalidRequest(): Response {
  return identityErrorResponse('Parameter error', 'invalid_request', 400);
}

/**
 * 凭据无效：**不区分**「id 不存在 / 密钥不对 / 已吊销 / 已过期」，避免给出枚举线索。
 * 区分这四种只写进审计事件，不写进响应。
 */
function invalidGrant(): Response {
  return identityErrorResponse('ClientId or clientSecret is incorrect. Try again', 'invalid_grant', 400);
}

export async function handleSecretsClientCredentials(
  _request: Request,
  env: Env,
  clientId: unknown,
  clientSecret: unknown
): Promise<Response> {
  const tokenId = typeof clientId === 'string' ? clientId.trim() : '';
  const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  if (!tokenId || !secret) return invalidRequest();

  const token = await getAccessTokenById(env.DB, tokenId);
  if (!token) return invalidGrant();
  if (!(await verifyApiKey(secret, token.secretHash))) return invalidGrant();
  if (token.revokedAt) return invalidGrant();
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return invalidGrant();

  const ttlSeconds = LIMITS.auth.accessTokenTtlSeconds;
  const accessToken = await createJWT(
    {
      sub: token.machineAccountId,
      email: '',
      name: null,
      email_verified: true,
      sstamp: SECRETS_ACCESS_TOKEN_STAMP,
      // `bws` 需要的两项：scope 必须是数组；organization 是它定位组织的依据
      scope: ['api.secrets'],
      organization: token.orgId,
    },
    env.JWT_SECRET,
    ttlSeconds
  );

  // 使用时间是观测值：写失败不该让本次签发失败
  try {
    await touchAccessTokenLastUsed(env.DB, token.id, new Date().toISOString());
  } catch {
    // ignore
  }

  return jsonResponse({
    access_token: accessToken,
    expires_in: ttlSeconds,
    token_type: 'Bearer',
    scope: 'api.secrets',
    encrypted_payload: token.encryptedPayload,
  });
}

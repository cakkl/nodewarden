import type { Env } from '../types';
import {
  ensureImplicitOrganization,
  getImplicitOrganization,
  getOrgKey,
  getTrashedSecret,
  listSecretProjectIds,
  listSecretTags,
  listTrashedSecrets,
  purgeSecretsByIds,
  restoreSecret,
  saveOrgKey,
  updateSecretTag,
  type SmSecret,
} from '../services/storage-secrets-repo';
import { SmEventType, recordSecretsEvents } from '../services/secrets-events';
import { broadcastSecretsManagerChange } from '../services/secrets-realtime';
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

  const orgKey = await getOrgKey(env.DB, organization.id);
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
  // 回吐**实际存储**的包裹：并发首次初始化时可能是别人先写的那把（见 `saveOrgKey`）
  const stored = await saveOrgKey(env.DB, organization.id, wrappedOrgKey);
  return jsonResponse({ id: organization.id, object: 'organizationKey', wrappedOrgKey: stored.wrappedOrgKey });
}

// ── 回收站（仅自家 Web UI）──────────────────────────────────────────────────
// 官方 `GET /api/secrets/{orgId}/trash` 是给 `bws` 的，而 `bws` 不用回收站 ⇒ 走 Web 自己的
// 命名空间，不把界面字段渗进官方线格式。

const TRASH_PATH = '/api/secrets/trash';
const TRASH_RESTORE_PATH = '/api/secrets/trash/restore';
const TRASH_PURGE_PATH = '/api/secrets/trash/purge';
/** ⚠️ 必须排在上面几个**之后**判定：`/trash/purge` 也会被这条匹配到（id = "purge"）。 */
const TRASH_ITEM_PATH = /^\/api\/secrets\/trash\/([^/]+)$/;

/** 列表项只回渲染需要的字段；值 / 备注走单取（`TRASH_ITEM_PATH`），与正常机密列表同一规矩。 */
function trashItem(secret: SmSecret, projectIds: string[]): Record<string, unknown> {
  return { id: secret.id, key: secret.keyEncrypted, deletedAt: secret.deletedAt, projectIds };
}

/**
 * `GET /api/secrets/trash`（列表）与 `POST /api/secrets/trash/restore`（还原）。
 *
 * ⚠️ 在 `router-authenticated.ts` 里必须**先于**官方形态分支：`/api/secrets/trash` 也会被
 * 「单段即 secret id」的规则匹配到。组织只反查、不创建（没有组织 ⇒ 回收站必为空）。
 */
export async function handleSecretsTrashRoute(
  request: Request,
  env: Env,
  userId: string,
  path: string,
  method: string
): Promise<Response | null> {
  if (path === TRASH_PATH) {
    if (method !== 'GET') return errorResponse('Method not allowed', 405);

    const organization = await getImplicitOrganization(env.DB, userId);
    if (!organization) return jsonResponse({ object: 'trash', secrets: [] });

    const secrets = await listTrashedSecrets(env.DB, organization.id);
    const links = await listSecretProjectIds(env.DB, organization.id);
    return jsonResponse({
      object: 'trash',
      secrets: secrets.map((secret) => trashItem(secret, links.get(secret.id) ?? [])),
    });
  }

  if (path === TRASH_RESTORE_PATH) {
    if (method !== 'POST') return errorResponse('Method not allowed', 405);

    let body: { ids?: unknown };
    try {
      body = (await request.json()) as { ids?: unknown };
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string' || !id)) {
      return errorResponse('ids must be an array of secret ids', 400);
    }

    const organization = await getImplicitOrganization(env.DB, userId);
    if (!organization) return jsonResponse({ object: 'trashRestore', restored: [] });

    const restored: string[] = [];
    for (const id of body.ids as string[]) {
      if (await restoreSecret(env.DB, organization.id, id)) restored.push(id);
    }
    broadcastSecretsManagerChange({ env, request, organizationId: organization.id, userId, kind: 'secrets' });
    await recordSecretsEvents({
      db: env.DB,
      request,
      actor: { type: 'user', id: userId, organizationId: organization.id },
      typeCode: SmEventType.SecretRestored,
      targets: restored.map((secretId) => ({ secretId })),
    });
    return jsonResponse({ object: 'trashRestore', restored });
  }

  if (path === TRASH_PURGE_PATH) {
    if (method !== 'POST') return errorResponse('Method not allowed', 405);

    let body: { ids?: unknown };
    try {
      body = (await request.json()) as { ids?: unknown };
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string' || !id)) {
      return errorResponse('ids must be an array of secret ids', 400);
    }

    const organization = await getImplicitOrganization(env.DB, userId);
    if (!organization) return jsonResponse({ object: 'trashPurge', purged: [] });

    const purged = await purgeSecretsByIds(env.DB, organization.id, body.ids as string[]);
    broadcastSecretsManagerChange({ env, request, organizationId: organization.id, userId, kind: 'secrets' });
    await recordSecretsEvents({
      db: env.DB,
      request,
      actor: { type: 'user', id: userId, organizationId: organization.id },
      typeCode: SmEventType.SecretPermanentlyDeleted,
      targets: purged.map((secretId) => ({ secretId })),
    });
    return jsonResponse({ object: 'trashPurge', purged });
  }

  // ⚠️ 放在最后：`/trash/purge` 这类固定子路径也会被这个正则匹配到
  const trashItemMatch = path.match(TRASH_ITEM_PATH);
  if (trashItemMatch) {
    if (method !== 'GET') return errorResponse('Method not allowed', 405);

    const organization = await getImplicitOrganization(env.DB, userId);
    if (!organization) return errorResponse('Not found', 404);

    const secret = await getTrashedSecret(env.DB, organization.id, decodeURIComponent(trashItemMatch[1]));
    if (!secret) return errorResponse('Not found', 404);

    const links = await listSecretProjectIds(env.DB, organization.id);
    return jsonResponse({
      object: 'secret',
      id: secret.id,
      key: secret.keyEncrypted,
      value: secret.valueEncrypted,
      note: secret.noteEncrypted,
      deletedAt: secret.deletedAt,
      projectIds: links.get(secret.id) ?? [],
    });
  }

  return null;
}

// ── 标签（仅自家 Web UI）────────────────────────────────────────────────────
// 官方线格式（`bws` / SDK 的 `SecretResponseModel`）没有标签字段 ⇒ 走与回收站同样的做法：
// Web 自己的命名空间，不把界面概念渗进官方契约。一个机密**至多一个**标签。

const TAGS_PATH = '/api/secrets/tags';
/** 标签只是短标识；上限防的是「拿超大密文撑着行」。 */
const MAX_TAG_CIPHER_LENGTH = 2048;

/**
 * `GET` 回全量映射（列表分组 + 编辑器自动补全共用一份），`PUT` 改单条。
 *
 * ⚠️ 只回**未删除**的条目（回收站不参与分组）；回收站里的标签仍在库里，还原后自动回来。
 * ⚠️ **不记审计事件、也不广播「机密变更」**：标签是 Web 独有的界面分组，不推进
 * `revision_date`（见 `updateSecretTag`）⇒ 若广播出去，等于把 CLI / 其它设备一并拉来重同步。
 * 多标签页之间各取所需，各自刷新即可。
 */
export async function handleSecretsTagRoute(
  request: Request,
  env: Env,
  userId: string,
  path: string,
  method: string
): Promise<Response | null> {
  if (path !== TAGS_PATH) return null;

  const organization = await getImplicitOrganization(env.DB, userId);

  if (method === 'GET') {
    if (!organization) return jsonResponse({ object: 'secretTags', tags: {} });
    const rows = await listSecretTags(env.DB, organization.id);
    const tags: Record<string, string> = {};
    for (const row of rows) {
      if (row.tagEncrypted) tags[row.id] = row.tagEncrypted;
    }
    return jsonResponse({ object: 'secretTags', tags });
  }

  if (method !== 'PUT') return errorResponse('Method not allowed', 405);

  let body: { secretId?: unknown; tag?: unknown };
  try {
    body = (await request.json()) as { secretId?: unknown; tag?: unknown };
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  if (typeof body.secretId !== 'string' || !body.secretId) {
    return errorResponse('secretId must be a secret id', 400);
  }
  // `null` = 清除标签；其余必须是合法密文（非法值会让客户端解密整页报错）。
  const tag = typeof body.tag === 'string' && body.tag ? body.tag : null;
  if (tag !== null && !isEncString(tag, MAX_TAG_CIPHER_LENGTH)) {
    return errorResponse('tag must be an EncString', 400);
  }

  if (!organization) return errorResponse('Not found', 404);
  const updated = await updateSecretTag(env.DB, organization.id, body.secretId, tag);
  if (!updated) return errorResponse('Not found', 404);
  // 让**同一个用户的其它 Web 标签页**刷新（自己那页按标签页标识挡掉回声）。
  // ⚠️ 这里可以放心广播：推送类型 103/104 是**本站自有**的号段（官方 SM 没有推送、只有拉取式同步），
  // 唯一消费方就是本仓的 Web 前端 ⇒ 不会把 CLI / 官方客户端拉来重同步。
  // ⚠️ 但仍**不记审计事件**（标签只是界面分组）。
  broadcastSecretsManagerChange({ env, request, organizationId: organization.id, userId, kind: 'secrets' });
  return jsonResponse({ object: 'secretTag', id: body.secretId, tag });
}

import { base64ToBytes, requireWebCrypto } from '../crypto';
import { t } from '../i18n';
import {
  SYMMETRIC_KEY_BYTES,
  accessTokenKeyPair,
  decryptField,
  encodeAccessTokenPayload,
  encryptField,
  formatAccessToken,
  generateTokenKeyMaterial,
  generateTokenSecret,
  hashTokenSecret,
  splitKeyPair,
  unwrapOrgKey,
  wrapOrgKey,
  type SmKeyPair,
} from '../secrets-crypto';
import {
  loadSecretsOfflineCache,
  saveCachedSecretsOfflineTags,
  saveCachedSecretsOfflineTrashDetail,
  saveSecretsOfflineCache,
  secretsOfflineSignature,
} from '../secrets-offline-cache';
import type { SessionState } from '../types';
import { parseErrorMessage, parseJson, type AuthedFetch } from './shared';

/**
 * 机密管理器的 Web 会话数据访问。
 *
 * 走的是**官方形态的那套端点**（`bws` 用的同一批），两条认证路径共用一份可见性过滤 ——
 * 否则迟早出现「网页看得到、CLI 看不到」。字段都是 EncString type 2：本层负责加解密，
 * 调用方只看到明文。⚠️ 列表端点**不含** value / note（官方契约），值要另走 `getSecretsByIds`。
 */

/** 会话上下文：组织 id + 原始组织密钥 + 拆好的密钥。 */
export interface SecretsContext {
  organizationId: string;
  /** 原始 64 字节（`enc ‖ mac`）。**创建访问令牌时要把它整体包进 `encrypted_payload`**。 */
  orgKey: Uint8Array;
  keyPair: SmKeyPair;
  /** 服务端存的那份包裹（用户密钥加密）—— 离线时据此重建上下文，见 `ensureOfflineSecretsContext`。 */
  wrappedOrgKey: string;
}

/** 线格式（`projects[]` 里的项目对象，字段都是密文）。 */
export interface RawSecretProject {
  id?: string;
  name?: string;
  creationDate?: string;
  revisionDate?: string;
}

/** 线格式的列表项（不含 value / note）。 */
export interface RawSecretSummary {
  id?: string;
  key?: string;
  projects?: RawSecretProject[];
  creationDate?: string;
  revisionDate?: string;
}

/** 线格式的完整机密（含密文 value / note）。 */
export interface RawSecretDetail extends RawSecretSummary {
  value?: string;
  note?: string;
}

/** 线格式的回收站列表项。 */
export interface RawTrashedSecret {
  id?: string;
  key?: string;
  deletedAt?: string;
  projectIds?: string[];
}

/** 线格式的回收站单项（含密文 value / note）。 */
export interface RawTrashedSecretDetail extends RawTrashedSecret {
  value?: string;
  note?: string;
}

export interface SecretProject {
  id: string;
  name: string;
  creationDate: string;
  revisionDate: string;
}

/** 列表项（名字已解密）。 */
export interface SecretSummary {
  id: string;
  name: string;
  projectIds: string[];
  creationDate: string;
  revisionDate: string;
}

/** 含值与备注的完整机密。 */
export interface SecretDetail extends SecretSummary {
  value: string;
  note: string;
}

/** 要写入的机密（明文）。 */
export interface SecretInput {
  key: string;
  value: string;
  note: string;
  projectIds: string[];
}

/** 批量操作的逐项结果（照官方：成功时 `error` 为 `null`）。 */
export interface SecretBatchResult {
  id: string;
  error: string | null;
}

/** 回收站列表项（不带值 / 备注 —— 与正常机密列表同一规矩）。 */
export interface TrashedSecret {
  id: string;
  name: string;
  deletedAt: string;
  projectIds: string[];
}

/** 回收站里单条的完整内容。 */
export interface TrashedSecretDetail extends TrashedSecret {
  value: string;
  note: string;
}

/** 由会话密钥解出 user key；未解锁时 `null`。 */
export function secretsUserKey(session: SessionState): SmKeyPair | null {
  if (!session.symEncKey || !session.symMacKey) return null;
  return { encKey: base64ToBytes(session.symEncKey), macKey: base64ToBytes(session.symMacKey) };
}

/** 一条坏密文不该让整页打不开（例如换了主密码之后的老数据）。 */
async function decryptOrFallback(cipher: string, keyPair: SmKeyPair): Promise<string> {
  try {
    return await decryptField(cipher, keyPair);
  } catch {
    return t('txt_decrypt_failed');
  }
}

function orgPath(ctx: SecretsContext, suffix: string): string {
  return `/api/organizations/${encodeURIComponent(ctx.organizationId)}${suffix}`;
}

async function readJsonOrThrow<T>(resp: Response, fallback: string): Promise<T> {
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, fallback));
  const body = await parseJson<T>(resp);
  if (!body) throw new Error(fallback);
  return body;
}

async function toSummary(raw: RawSecretSummary, keyPair: SmKeyPair): Promise<SecretSummary | null> {
  if (!raw?.id || !raw.key) return null;
  return {
    id: raw.id,
    name: await decryptOrFallback(raw.key, keyPair),
    projectIds: (raw.projects ?? []).map((project) => project?.id).filter((id): id is string => !!id),
    creationDate: raw.creationDate ?? '',
    revisionDate: raw.revisionDate ?? '',
  };
}

async function toDetail(raw: RawSecretDetail, keyPair: SmKeyPair): Promise<SecretDetail | null> {
  const summary = await toSummary(raw, keyPair);
  if (!summary) return null;
  return {
    ...summary,
    value: raw.value ? await decryptOrFallback(raw.value, keyPair) : '',
    note: raw.note ? await decryptOrFallback(raw.note, keyPair) : '',
  };
}

/**
 * 取组织密钥（首次进入时生成并上传），得到可用的会话上下文。
 *
 * ⚠️ 首次上传后要用**服务端回吐的**包裹：两个标签页并发首次进入会各生成一把，后写的那把
 * 若被采用，先写方的密文就永久解不开了。服务端是「首次写入胜出」并回吐实际存储值，这里
 * 必须据此对齐。
 */
export async function ensureSecretsContext(authedFetch: AuthedFetch, session: SessionState): Promise<SecretsContext> {
  const userKey = secretsUserKey(session);
  if (!userKey) throw new Error('Secrets key unavailable');

  const org = await readJsonOrThrow<{ id?: string }>(
    await authedFetch('/api/secrets/organization'),
    t('txt_load_failed')
  );
  if (!org.id) throw new Error(t('txt_load_failed'));
  const organizationId = org.id;

  const existing = await readJsonOrThrow<{ wrappedOrgKey?: string | null }>(
    await authedFetch('/api/secrets/organization-key'),
    t('txt_load_failed')
  );
  if (existing.wrappedOrgKey) {
    const orgKey = await unwrapOrgKey(existing.wrappedOrgKey, userKey);
    return { organizationId, orgKey, keyPair: splitKeyPair(orgKey), wrappedOrgKey: existing.wrappedOrgKey };
  }

  const generated = requireWebCrypto().getRandomValues(new Uint8Array(SYMMETRIC_KEY_BYTES));
  const wrapped = await wrapOrgKey(generated, userKey);
  const saved = await readJsonOrThrow<{ wrappedOrgKey?: string | null }>(
    await authedFetch('/api/secrets/organization-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrappedOrgKey: wrapped }),
    }),
    t('txt_save_failed')
  );

  const authoritative = saved.wrappedOrgKey && saved.wrappedOrgKey !== wrapped ? saved.wrappedOrgKey : wrapped;
  const orgKey = authoritative === wrapped ? generated : await unwrapOrgKey(authoritative, userKey);
  return { organizationId, orgKey, keyPair: splitKeyPair(orgKey), wrappedOrgKey: authoritative };
}

// ── 项目 ────────────────────────────────────────────────────────────────────

export async function listSecretProjects(authedFetch: AuthedFetch, ctx: SecretsContext): Promise<SecretProject[]> {
  const body = await readJsonOrThrow<{
    data?: Array<{ id?: string; name?: string; creationDate?: string; revisionDate?: string }>;
  }>(await authedFetch(orgPath(ctx, '/projects')), t('txt_load_failed'));
  const projects = Array.isArray(body.data) ? body.data : [];
  return Promise.all(
    projects
      .filter(
        (project): project is { id: string; name: string; creationDate?: string; revisionDate?: string } =>
          !!project?.id && !!project.name
      )
      .map(async (project) => ({
        id: project.id,
        name: await decryptOrFallback(project.name, ctx.keyPair),
        creationDate: project.creationDate ?? '',
        revisionDate: project.revisionDate ?? '',
      }))
  );
}

export async function createSecretProject(authedFetch: AuthedFetch, ctx: SecretsContext, name: string): Promise<SecretProject> {
  const body = await readJsonOrThrow<{ id?: string; creationDate?: string; revisionDate?: string }>(
    await authedFetch(orgPath(ctx, '/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: await encryptField(name, ctx.keyPair) }),
    }),
    t('txt_save_failed')
  );
  if (!body.id) throw new Error(t('txt_save_failed'));
  return { id: body.id, name, creationDate: body.creationDate ?? '', revisionDate: body.revisionDate ?? '' };
}

export async function updateSecretProject(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  id: string,
  name: string
): Promise<SecretProject> {
  const body = await readJsonOrThrow<{ creationDate?: string; revisionDate?: string }>(
    await authedFetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: await encryptField(name, ctx.keyPair) }),
    }),
    t('txt_save_failed')
  );
  return { id, name, creationDate: body.creationDate ?? '', revisionDate: body.revisionDate ?? '' };
}

/** 删项目（硬删，照官方）；返回逐项结果。 */
export async function deleteSecretProjects(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  ids: string[]
): Promise<SecretBatchResult[]> {
  const body = await readJsonOrThrow<{ data?: SecretBatchResult[] }>(
    await authedFetch('/api/projects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids),
    }),
    t('txt_delete_item_failed')
  );
  return Array.isArray(body.data) ? body.data : [];
}

// ── 机密 ────────────────────────────────────────────────────────────────────

/**
 * 列机密（含该组织可见的项目列表，省一次往返）。
 *
 * ⚠️ 返回项**没有** value / note —— 官方列表契约如此，值要走 `getSecretsByIds`。
 * `raw` 是同一份响应的原始线格式，交给离线快照复用（不额外发请求）。
 */
export async function listSecrets(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  projectId?: string
): Promise<{ secrets: SecretSummary[]; projects: SecretProject[]; raw: RawSecretsList }> {
  const path = projectId ? `/api/projects/${encodeURIComponent(projectId)}/secrets` : orgPath(ctx, '/secrets');
  const body = await readJsonOrThrow<{
    secrets?: RawSecretSummary[];
    projects?: RawSecretProject[];
  }>(await authedFetch(path), t('txt_load_failed'));

  return { ...(await decryptSecretsList(body, ctx.keyPair)), raw: { secrets: body.secrets ?? [], projects: body.projects ?? [] } };
}

/** 原始线格式的列表信封（列表端点与 `sync` 共用一套元素形状）。 */
export interface RawSecretsList {
  secrets: RawSecretSummary[];
  projects: RawSecretProject[];
}

async function decryptSecretsList(
  body: { secrets?: RawSecretSummary[]; projects?: RawSecretProject[] },
  keyPair: SmKeyPair
): Promise<{ secrets: SecretSummary[]; projects: SecretProject[] }> {
  const secrets = (await Promise.all((body.secrets ?? []).map((raw) => toSummary(raw, keyPair)))).filter(
    (secret): secret is SecretSummary => !!secret
  );
  const projects = await Promise.all(
    (body.projects ?? [])
      .filter(
        (project): project is { id: string; name: string; creationDate?: string; revisionDate?: string } =>
          !!project?.id && !!project.name
      )
      .map(async (project) => ({
        id: project.id,
        name: await decryptOrFallback(project.name, keyPair),
        creationDate: project.creationDate ?? '',
        revisionDate: project.revisionDate ?? '',
      }))
  );
  return { secrets, projects };
}

/** 批量取机密（含值 / 备注）。不可见的 id 会被服务端静默跳过。 */
export async function getSecretsByIds(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  ids: string[]
): Promise<SecretDetail[]> {
  const body = await readJsonOrThrow<{ data?: RawSecretDetail[] }>(
    await authedFetch('/api/secrets/get-by-ids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
    t('txt_load_failed')
  );
  const details = await Promise.all((body.data ?? []).map((raw) => toDetail(raw, ctx.keyPair)));
  return details.filter((detail): detail is SecretDetail => !!detail);
}

async function encryptInput(input: SecretInput, ctx: SecretsContext): Promise<Record<string, unknown>> {
  return {
    key: await encryptField(input.key, ctx.keyPair),
    value: await encryptField(input.value, ctx.keyPair),
    // ⚠️ 空备注也要发**密文**（空串的 EncString）。官方客户端同样如此：`bws secret list` 会把
    // 每个 secret 的 key / value / note 都按 EncString 解析，收到空串会直接报错。
    note: await encryptField(input.note ?? '', ctx.keyPair),
    projectIds: input.projectIds,
  };
}

export async function createSecret(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  input: SecretInput
): Promise<SecretDetail> {
  const body = await readJsonOrThrow<RawSecretDetail>(
    await authedFetch(orgPath(ctx, '/secrets'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await encryptInput(input, ctx)),
    }),
    t('txt_create_item_failed')
  );
  const detail = await toDetail(body, ctx.keyPair);
  if (!detail) throw new Error(t('txt_create_item_failed'));
  return detail;
}

export async function updateSecret(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  id: string,
  input: SecretInput
): Promise<SecretDetail> {
  const body = await readJsonOrThrow<RawSecretDetail>(
    await authedFetch(`/api/secrets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await encryptInput(input, ctx)),
    }),
    t('txt_update_item_failed')
  );
  const detail = await toDetail(body, ctx.keyPair);
  if (!detail) throw new Error(t('txt_update_item_failed'));
  return detail;
}

/**
 * 批量调整所属项目。
 * ⚠️ 官方只有**单条** PUT，且要求一并带上 key / value / note ⇒ 先取回明细（含明文）再逐条提交。
 * 逐条给**各自**的集合：多选时「没动过的项目」对每条机密是保持原样的，不能共用一个集合。
 */
export async function setSecretsProjects(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  assignments: ReadonlyArray<{ id: string; projectIds: string[] }>
): Promise<void> {
  if (!assignments.length) return;
  const details = await getSecretsByIds(
    authedFetch,
    ctx,
    assignments.map((assignment) => assignment.id)
  );
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  for (const assignment of assignments) {
    const detail = byId.get(assignment.id);
    if (!detail) continue;
    await updateSecret(authedFetch, ctx, assignment.id, {
      key: detail.name,
      value: detail.value,
      note: detail.note,
      projectIds: assignment.projectIds,
    });
  }
}

/** 软删（进回收站，满 30 天由服务端 scheduled 物理清除）。 */
export async function deleteSecrets(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  ids: string[]
): Promise<SecretBatchResult[]> {
  const body = await readJsonOrThrow<{ data?: SecretBatchResult[] }>(
    await authedFetch('/api/secrets/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids),
    }),
    t('txt_delete_item_failed')
  );
  return Array.isArray(body.data) ? body.data : [];
}

// ── 回收站 ──────────────────────────────────────────────────────────────────

export async function listTrashedSecrets(authedFetch: AuthedFetch, ctx: SecretsContext): Promise<TrashedSecret[]> {
  const body = await readJsonOrThrow<{ secrets?: Array<{ id?: string; key?: string; deletedAt?: string; projectIds?: string[] }> }>(
    await authedFetch('/api/secrets/trash'),
    t('txt_load_failed')
  );
  const rows = (body.secrets ?? []).filter(
    (row): row is { id: string; key: string; deletedAt?: string; projectIds?: string[] } => !!row?.id && !!row.key
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: await decryptOrFallback(row.key, ctx.keyPair),
      deletedAt: row.deletedAt ?? '',
      projectIds: row.projectIds ?? [],
    }))
  );
}

/** 取回收站里单条的完整内容（含值 / 备注）。传了 `cacheKey` 就顺手把这份密文补进离线缓存。 */
export async function getTrashedSecret(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  id: string,
  cacheKey?: string
): Promise<TrashedSecretDetail | null> {
  const resp = await authedFetch(`/api/secrets/trash/${encodeURIComponent(id)}`);
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_load_failed')));
  const body = await parseJson<RawTrashedSecretDetail>(resp);
  if (!body?.id || !body.key) return null;
  if (cacheKey) void saveCachedSecretsOfflineTrashDetail(cacheKey, body.id, body);
  return {
    id: body.id,
    name: await decryptOrFallback(body.key, ctx.keyPair),
    value: body.value ? await decryptOrFallback(body.value, ctx.keyPair) : '',
    note: body.note ? await decryptOrFallback(body.note, ctx.keyPair) : '',
    deletedAt: body.deletedAt ?? '',
    projectIds: body.projectIds ?? [],
  };
}

/** 从回收站还原；返回真的被还原的 id。 */
export async function restoreTrashedSecrets(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  ids: string[]
): Promise<string[]> {
  const body = await readJsonOrThrow<{ restored?: string[] }>(
    await authedFetch('/api/secrets/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
    t('txt_bulk_restore_failed')
  );
  return Array.isArray(body.restored) ? body.restored : [];
}

/** 从回收站**永久删除**（不可撤销）；返回真的被删除的 id。 */
export async function purgeTrashedSecrets(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  ids: string[]
): Promise<string[]> {
  const body = await readJsonOrThrow<{ purged?: string[] }>(
    await authedFetch('/api/secrets/trash/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
    t('txt_permanent_delete_item_failed')
  );
  return Array.isArray(body.purged) ? body.purged : [];
}

// ── 标签（仅 Web）─────────────────────────────────────────────────────────

/**
 * 取「机密 id → 标签明文」映射。
 *
 * 标签是本站 Web 扩展（官方线格式没有这个字段）⇒ 单独一个端点。同一份数据同时喂两个用途：
 * 列表分组、编辑器里输入标签时的候选。
 */
export async function listSecretTags(
  authedFetch: AuthedFetch,
  ctx: SecretsContext
): Promise<{ tagsBySecretId: Record<string, string>; allTags: string[]; raw: Record<string, string> }> {
  const body = await readJsonOrThrow<{ tags?: Record<string, string> }>(
    await authedFetch('/api/secrets/tags'),
    t('txt_load_failed')
  );
  const raw: Record<string, string> = {};
  const tagsBySecretId: Record<string, string> = {};
  const allTags: string[] = [];
  for (const [id, cipher] of Object.entries(body.tags ?? {})) {
    if (!id || !cipher) continue;
    raw[id] = cipher;
    // 一条坏密文不该让整页打不开 ⇒ 与列表同一口气（解密失败显占位）。
    const plain = await decryptOrFallback(cipher, ctx.keyPair);
    tagsBySecretId[id] = plain;
    if (!allTags.includes(plain)) allTags.push(plain);
  }
  allTags.sort((a, b) => a.localeCompare(b));
  return { tagsBySecretId, allTags, raw };
}

/** 设/清一个机密的标签（`null` = 清除）。 */
export async function saveSecretTag(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  secretId: string,
  tag: string | null
): Promise<Response> {
  const response = await authedFetch('/api/secrets/tags', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secretId, tag: tag === null ? null : await encryptField(tag, ctx.keyPair) }),
  });
  if (!response.ok) throw new Error(await parseErrorMessage(response, t('txt_save_failed')));
  return response;
}

// ── 离线只读缓存 ────────────────────────────────────────────────────────────

/**
 * 把最新的全量密文快照写进本地缓存（尽力而为，失败不抛）。
 * ⚠️ 线格式不报「已删除」（`sync` 只回活着的行）⇒ 缓存只能整份覆盖，所以先用签名比对，
 * 否则每进一次页面都要重传全量密文。
 *
 * `rawTags` 是标签的**密文**映射（标签不进签名 ⇒ 单独比对），`null` = 这次没取到：
 * ⚠️ 那时必须**保留缓存里的旧标签** —— 当成空映射会把离线分组凭空抹掉。
 */
export async function refreshSecretsOfflineSnapshot(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  cacheKey: string,
  listed: RawSecretsList,
  rawTags: Record<string, string> | null
): Promise<void> {
  if (!cacheKey || !ctx.wrappedOrgKey) return;
  try {
    const cached = await loadSecretsOfflineCache(cacheKey);
    const signature = secretsOfflineSignature(listed.secrets, listed.projects);
    if (
      cached &&
      cached.signature === signature &&
      cached.organizationId === ctx.organizationId &&
      cached.wrappedOrgKey === ctx.wrappedOrgKey
    ) {
      // 快照是最新的；但标签与签名无关，得单独同步一次（否则刚打的标签离线看不到）。
      // ⚠️ `rawTags` 为 `null`（这次没取到）时什么都不做 —— 不能当成「标签被删光了」。
      if (rawTags && !sameStringMap(cached.tags, rawTags)) {
        await saveCachedSecretsOfflineTags(cacheKey, rawTags);
      }
      return;
    }

    // 官方同步端点：省略 `lastSyncedDate` = 回全量，且元素**含密文 value / note**
    // （列表端点拿不到值，那正是离线只读需要的东西）。
    const response = await authedFetch(orgPath(ctx, '/secrets/sync'));
    if (!response.ok) return;
    const body = await parseJson<{ secrets?: { data?: RawSecretDetail[] } }>(response);
    const secrets = Array.isArray(body?.secrets?.data) ? body.secrets.data : [];
    // ⚠️「列表里有机密、同步却回空」才是异常（形状对不上）⇒ 宁可用旧快照；「本来就没有机密」
    // 时回空是**正常**的，必须照常记下来，否则新账号离线连空列表都看不到。
    if (secrets.length === 0 && listed.secrets.length > 0) return;

    // 回收站：列表端点不含它，只能另取一次（没有批量详情接口 ⇒ 内容靠惰性积累）。
    const trashResponse = await authedFetch('/api/secrets/trash');
    const trashBody = trashResponse.ok
      ? await parseJson<{ secrets?: RawTrashedSecret[] }>(trashResponse)
      : null;
    const trash = Array.isArray(trashBody?.secrets) ? trashBody.secrets : (cached?.trash ?? []);
    const aliveIds = new Set(trash.map((row) => row.id).filter((id): id is string => !!id));
    const cachedTrashDetails = cached?.trashDetails ?? {};
    const trashDetails = Object.fromEntries(
      Object.entries(cachedTrashDetails).filter(([id]) => aliveIds.has(id))
    );

    await saveSecretsOfflineCache(cacheKey, {
      organizationId: ctx.organizationId,
      signature,
      wrappedOrgKey: ctx.wrappedOrgKey,
      projects: listed.projects,
      secrets,
      tags: rawTags ?? cached?.tags ?? {},
      trash,
      trashDetails,
    });
  } catch {
    // 离线缓存是尽力而为的旁路：失败不该影响在线流程
  }
}

/** 两个「字符串→字符串」映射内容是否一致。 */
function sameStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** 离线读标签：解出「id → 明文」与去重排序后的候选清单（与在线同一形状）。 */
export async function loadOfflineSecretTags(
  ctx: SecretsContext,
  cacheKey: string
): Promise<{ tagsBySecretId: Record<string, string>; allTags: string[] }> {
  const record = await loadSecretsOfflineCache(cacheKey);
  const tagsBySecretId: Record<string, string> = {};
  const allTags: string[] = [];
  for (const [id, cipher] of Object.entries(record?.tags ?? {})) {
    const plain = await decryptOrFallback(cipher, ctx.keyPair);
    tagsBySecretId[id] = plain;
    if (!allTags.includes(plain)) allTags.push(plain);
  }
  allTags.sort((a, b) => a.localeCompare(b));
  return { tagsBySecretId, allTags };
}

/**
 * 离线上下文：缓存里的组织密钥包裹 + 本次解锁的会话密钥。
 * 没有缓存、或包裹解不开（换了账号 / 换了主密码）时返回 `null`。
 */
export async function ensureOfflineSecretsContext(
  session: SessionState,
  cacheKey: string
): Promise<SecretsContext | null> {
  const userKey = secretsUserKey(session);
  if (!userKey || !cacheKey) return null;
  const record = await loadSecretsOfflineCache(cacheKey);
  if (!record) return null;
  try {
    const orgKey = await unwrapOrgKey(record.wrappedOrgKey, userKey);
    return {
      organizationId: record.organizationId,
      orgKey,
      keyPair: splitKeyPair(orgKey),
      wrappedOrgKey: record.wrappedOrgKey,
    };
  } catch {
    return null;
  }
}

async function toTrashedSummary(raw: RawTrashedSecret, keyPair: SmKeyPair): Promise<TrashedSecret | null> {
  if (!raw?.id || !raw.key) return null;
  return {
    id: raw.id,
    name: await decryptOrFallback(raw.key, keyPair),
    deletedAt: raw.deletedAt ?? '',
    projectIds: raw.projectIds ?? [],
  };
}

/** 离线列表（机密 / 项目），由缓存里的密文解出。没有缓存则 `null`。 */
export async function loadOfflineSecrets(
  ctx: SecretsContext,
  cacheKey: string
): Promise<{ secrets: SecretSummary[]; projects: SecretProject[] } | null> {
  const record = await loadSecretsOfflineCache(cacheKey);
  if (!record) return null;
  return decryptSecretsList({ secrets: record.secrets, projects: record.projects }, ctx.keyPair);
}

/** 离线回收站列表（名称 / 删除时间 / 项目关联；内容另走 `getOfflineTrashedSecretDetail`）。 */
export async function loadOfflineTrash(
  ctx: SecretsContext,
  cacheKey: string
): Promise<TrashedSecret[] | null> {
  const record = await loadSecretsOfflineCache(cacheKey);
  if (!record) return null;
  return (await Promise.all(record.trash.map((raw) => toTrashedSummary(raw, ctx.keyPair)))).filter(
    (item): item is TrashedSecret => !!item
  );
}

/** 离线取单条机密：缓存里存的是**全量含值密文** ⇒ 离线时看内容永远不成问题。 */
export async function getOfflineSecretDetail(
  ctx: SecretsContext,
  cacheKey: string,
  id: string
): Promise<SecretDetail | null> {
  const record = await loadSecretsOfflineCache(cacheKey);
  const raw = record?.secrets.find((item) => item.id === id);
  if (!raw) return null;
  return toDetail(raw, ctx.keyPair);
}

/** 离线的回收站单项内容；「没看过内容」的那条返回 `null`（界面提示需要联网）。 */
export async function getOfflineTrashedSecretDetail(
  ctx: SecretsContext,
  cacheKey: string,
  id: string
): Promise<TrashedSecretDetail | null> {
  const record = await loadSecretsOfflineCache(cacheKey);
  const raw = record?.trashDetails?.[id];
  if (!raw) return null;
  const summary = await toTrashedSummary(raw, ctx.keyPair);
  if (!summary) return null;
  return {
    ...summary,
    value: raw.value ? await decryptOrFallback(raw.value, ctx.keyPair) : '',
    note: raw.note ? await decryptOrFallback(raw.note, ctx.keyPair) : '',
  };
}

// ── 机器账号与访问令牌 ──────────────────────────────────────────────────────

/** 机器账号（程序身份）。名字是明文（与官方一致）。 */
export interface MachineAccount {
  id: string;
  name: string;
  creationDate: string;
  /** 名称 / 项目授权的最后变更时间（令牌不算）。 */
  revisionDate: string;
}

/** 机器账号对某个 project 的权限（程序侧唯一的授权来源）。 */
export interface MachineAccountGrant {
  projectId: string;
  permission: 'read' | 'write';
}

export interface MachineAccountDetail extends MachineAccount {
  grants: MachineAccountGrant[];
}

/** 访问令牌。⚠️ **不含明文**：明文只在创建的那一刻返回。 */
export interface MachineAccountToken {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  creationDate: string;
}

/** 创建令牌的返回值：`plaintext` 只在这里出现一次，之后服务端也拿不出来。 */
export interface CreatedMachineAccountToken {
  token: MachineAccountToken;
  plaintext: string;
}

type RawMachineAccount = { id?: string; name?: string; createdAt?: string; revisionDate?: string; grants?: Array<{ projectId?: string; permission?: string }> };
type RawToken = {
  id?: string;
  name?: string;
  expiresAt?: string;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string;
};

function toGrant(raw: { projectId?: string; permission?: string }): MachineAccountGrant | null {
  if (!raw?.projectId || (raw.permission !== 'read' && raw.permission !== 'write')) return null;
  return { projectId: raw.projectId, permission: raw.permission };
}

function toToken(raw: RawToken): MachineAccountToken | null {
  if (!raw?.id || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    expiresAt: raw.expiresAt ?? '',
    revokedAt: raw.revokedAt ?? null,
    lastUsedAt: raw.lastUsedAt ?? null,
    creationDate: raw.createdAt ?? '',
  };
}

export async function listMachineAccounts(authedFetch: AuthedFetch, ctx: SecretsContext): Promise<MachineAccountDetail[]> {
  const body = await readJsonOrThrow<{ data?: RawMachineAccount[] }>(
    await authedFetch('/api/secrets/machine-accounts'),
    t('txt_load_failed')
  );
  return (body.data ?? [])
    .filter((raw): raw is RawMachineAccount & { id: string; name: string } => !!raw?.id && !!raw.name)
    .map((raw) => ({
      id: raw.id,
      name: raw.name,
      creationDate: raw.createdAt ?? '',
      revisionDate: raw.revisionDate ?? raw.createdAt ?? '',
      grants: (raw.grants ?? []).map(toGrant).filter((grant): grant is MachineAccountGrant => !!grant),
    }));
}

export async function createMachineAccount(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  name: string
): Promise<MachineAccount> {
  const body = await readJsonOrThrow<RawMachineAccount>(
    await authedFetch('/api/secrets/machine-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    t('txt_save_failed')
  );
  if (!body.id) throw new Error(t('txt_save_failed'));
  return {
    id: body.id,
    name: body.name ?? name,
    creationDate: body.createdAt ?? '',
    revisionDate: body.revisionDate ?? body.createdAt ?? '',
  };
}

/** 改名。名字是明文，服务端直接更新 —— 授权与令牌不受影响。 */
export async function renameMachineAccount(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  id: string,
  name: string
): Promise<void> {
  const resp = await authedFetch(`/api/secrets/machine-accounts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_save_failed')));
}

export async function deleteMachineAccount(authedFetch: AuthedFetch, ctx: SecretsContext, id: string): Promise<void> {
  const resp = await authedFetch(`/api/secrets/machine-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_item_failed')));
}

/** 授予 / 改写某个 project 的权限（同一对 (账号, 项目) 是 upsert）。 */
export async function setMachineAccountGrant(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  machineAccountId: string,
  projectId: string,
  permission: 'read' | 'write'
): Promise<void> {
  const resp = await authedFetch(`/api/secrets/machine-accounts/${encodeURIComponent(machineAccountId)}/grants`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, permission }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_save_failed')));
}

export async function removeMachineAccountGrant(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  machineAccountId: string,
  projectId: string
): Promise<void> {
  const resp = await authedFetch(
    `/api/secrets/machine-accounts/${encodeURIComponent(machineAccountId)}/grants/${encodeURIComponent(projectId)}`,
    { method: 'DELETE' }
  );
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_item_failed')));
}

/** ⚠️ 返回里没有明文（服务端也拿不出来）；要明文只能创建时那一次。 */
export async function listMachineAccountTokens(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  machineAccountId: string
): Promise<MachineAccountToken[]> {
  const body = await readJsonOrThrow<{ data?: RawToken[] }>(
    await authedFetch(`/api/secrets/machine-accounts/${encodeURIComponent(machineAccountId)}/tokens`),
    t('txt_load_failed')
  );
  return (body.data ?? []).map(toToken).filter((token): token is MachineAccountToken => !!token);
}

/**
 * 创建访问令牌。
 *
 * ⚠️ 明文密钥与密钥材料都在**客户端**生成：服务端只收到 `sha256(密钥)` 与「用令牌密钥包住的
 * 组织密钥」。返回的明文令牌**只显示这一次**。
 */
export async function createMachineAccountToken(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  machineAccountId: string,
  name: string,
  expiresAt: string
): Promise<CreatedMachineAccountToken> {
  const secret = generateTokenSecret();
  const keyMaterial = generateTokenKeyMaterial();
  const tokenKey = await accessTokenKeyPair(keyMaterial);

  const body = await readJsonOrThrow<RawToken>(
    await authedFetch(`/api/secrets/machine-accounts/${encodeURIComponent(machineAccountId)}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        secretHash: await hashTokenSecret(secret),
        encryptedPayload: await encodeAccessTokenPayload(ctx.orgKey, tokenKey),
        expiresAt,
      }),
    }),
    t('txt_create_item_failed')
  );
  if (!body.id) throw new Error(t('txt_create_item_failed'));

  const token = toToken(body);
  if (!token) throw new Error(t('txt_create_item_failed'));
  return { token, plaintext: formatAccessToken(token.id, secret, keyMaterial) };
}

export async function revokeMachineAccountToken(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  tokenId: string
): Promise<void> {
  const resp = await authedFetch(`/api/secrets/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_item_failed')));
}

// ── 事件日志 ─────────────────────────────────────────────────────────────────

/** 事件日志的一条。目标对象已被永久删除时 `name` 为 `null` —— 事件本身仍要显示。 */
export interface MachineAccountEvent {
  id: string;
  actorType: 'user' | 'machine_account';
  /** 官方的数字类型码（2100 起）。 */
  typeCode: number;
  secretId: string | null;
  projectId: string | null;
  /** 解密后的目标名称；目标已不存在时为 `null`。 */
  name: string | null;
  creationDate: string;
}

export interface MachineAccountEventsPage {
  events: MachineAccountEvent[];
  hasMore: boolean;
}

type RawEvent = {
  id?: string;
  actorType?: string;
  typeCode?: number;
  secretId?: string | null;
  secretKey?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  createdAt?: string;
};

/**
 * 机器账号的事件日志（时间倒序，键集分页）。
 *
 * ⚠️ 游标是 `before`（时间）+ `beforeId`（事件 id）两个值，必须**成对**传：一次批量操作的事件
 * 共用同一时间戳，只给时间会在翻页时丢掉同毫秒剩下的记录。
 * ⚠️ 目标名称是**密文**，在这里解密 —— 与其它端点同一规矩，服务端从不碰明文。
 */
export async function listMachineAccountEvents(
  authedFetch: AuthedFetch,
  ctx: SecretsContext,
  machineAccountId: string,
  options: { limit?: number; before?: string; beforeId?: string } = {}
): Promise<MachineAccountEventsPage> {
  const query = new URLSearchParams();
  if (options.limit) query.set('limit', String(options.limit));
  if (options.before) query.set('before', options.before);
  if (options.beforeId) query.set('beforeId', options.beforeId);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const body = await readJsonOrThrow<{ data?: RawEvent[]; hasMore?: boolean }>(
    await authedFetch(`/api/secrets/machine-accounts/${encodeURIComponent(machineAccountId)}/events${suffix}`),
    t('txt_load_failed')
  );

  const events: MachineAccountEvent[] = [];
  for (const raw of body.data ?? []) {
    if (!raw?.id || typeof raw.typeCode !== 'number') continue;
    const cipher = raw.secretKey || raw.projectName || '';
    events.push({
      id: raw.id,
      actorType: raw.actorType === 'machine_account' ? 'machine_account' : 'user',
      typeCode: raw.typeCode,
      secretId: raw.secretId ?? null,
      projectId: raw.projectId ?? null,
      name: cipher ? await decryptOrFallback(cipher, ctx.keyPair) : null,
      creationDate: raw.createdAt ?? '',
    });
  }
  return { events, hasMore: !!body.hasMore };
}

import type { Env } from '../types';
import { setMachineAccountGrant } from '../services/storage-secrets-machine-repo';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProjectName,
  type SmProject,
} from '../services/storage-secrets-project-repo';
import {
  createSecret,
  getSecretById,
  listOrgSecrets,
  listProjectSecrets,
  listSecretProjectIds,
  listSecretsChangedSince,
  setSecretProjects,
  softDeleteSecrets,
  updateSecret,
  type SmSecret,
} from '../services/storage-secrets-repo';
import { permissionForProject, resolveSecretsPrincipal, resolveSecretsUserPrincipal, grantedProjectIds, writableProjectIds, type SmPrincipal } from '../services/secrets-access';
import { SmEventType, eventActorOf, recordSecretsEvents } from '../services/secrets-events';
import { broadcastSecretsManagerChange, type SmRealtimeKind } from '../services/secrets-realtime';
import { errorResponse, jsonResponse } from '../utils/response';
import { generateUUID } from '../utils/uuid';
import { isEncString } from './secrets-shared';

/**
 * 官方形态的机密管理器端点（`bws` 用的那套）。
 *
 * ⚠️ 两条认证路、一个实现：机器账号令牌与用户会话都走这里 ⇒ 可见性过滤只有一份，
 * 不会出现「网页看得到、CLI 看不到」。
 *
 * 路由上有两个坑：① 机器令牌那路要在 `router.ts` 的用户闸门**之前**试（否则 SM 令牌先被
 * 当成坏令牌 401），但**不是** SM 令牌时必须返回 `null` 放行，让 Web 会话走到闸门之后；
 * ② `/api/secrets/organization*` 等 Web 自有路径会被「单段即 secret id」的规则匹配到，
 * `router-authenticated.ts` 必须先判它们。
 *
 * 权限（Web 与 CLI 同一套）：按 project 严格过滤 —— 读要 `read`，改 / 删 / 建还要 `write`，
 * 且**目标 project 本身**也要有 write（见 `resolveProjectIds`）。反过来的怪规则照抄官方：
 * **只读的机器账号也能建 project**（建完自动获得该 project 的 write，否则它看不见自己刚建的东西）。
 */

const ORG_PROJECTS_PATH = /^\/api\/organizations\/([^/]+)\/projects$/;
const PROJECT_PATH = /^\/api\/projects\/([^/]+)$/;
const PROJECTS_DELETE_PATH = '/api/projects/delete';
const ORG_SECRETS_PATH = /^\/api\/organizations\/([^/]+)\/secrets$/;
const ORG_SECRETS_SYNC_PATH = /^\/api\/organizations\/([^/]+)\/secrets\/sync$/;
const PROJECT_SECRETS_PATH = /^\/api\/projects\/([^/]+)\/secrets$/;
const SECRET_PATH = /^\/api\/secrets\/([^/]+)$/;
const SECRETS_GET_BY_IDS_PATH = '/api/secrets/get-by-ids';
const SECRETS_DELETE_PATH = '/api/secrets/delete';

/**
 * 密文长度上限。
 *
 * ⚠️ 官方那套 `key ≤ 500` / `value ≤ 25 000` / `note ≤ 7 000` 是**明文**限制，由 SDK 在客户端
 * 先拦；服务端只见到密文（约 4/3 膨胀 + 少量开销），所以这里给的是宽裕的密文上限。
 */
const MAX_KEY_CIPHER_LENGTH = 2048;
const MAX_VALUE_CIPHER_LENGTH = 40_000;
const MAX_NOTE_CIPHER_LENGTH = 12_000;

/** 本模块接管的路径（其余交回 `router.ts` 的用户令牌流程）。 */
export function isSecretsApiPath(path: string): boolean {
  return (
    ORG_PROJECTS_PATH.test(path) ||
    PROJECT_PATH.test(path) ||
    path === PROJECTS_DELETE_PATH ||
    ORG_SECRETS_PATH.test(path) ||
    ORG_SECRETS_SYNC_PATH.test(path) ||
    PROJECT_SECRETS_PATH.test(path) ||
    SECRET_PATH.test(path) ||
    path === SECRETS_GET_BY_IDS_PATH ||
    path === SECRETS_DELETE_PATH
  );
}

function projectToResponse(project: SmProject): Record<string, unknown> {
  return {
    id: project.id,
    organizationId: project.orgId,
    name: project.nameEncrypted,
    creationDate: project.createdAt,
    revisionDate: project.revisionDate,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 批量删的响应元素：成功时 `error` 为 `null`。 */
function batchResult(id: string, error: string | null): Record<string, unknown> {
  return { id, error };
}

/**
 * 列表用的 secret 摘要。
 *
 * ⚠️ **不含 `value` / `note`**：官方列表只回标识与密文的 key，值要走 `get-by-ids` 单独取
 * （`bws` 也是「先 list 再 get-by-ids」两步）。
 * ⚠️ 内层 `projects[]` 要填**完整**的 project 对象：SDK 读的是内层，不是外层。
 */
function secretSummary(secret: SmSecret, projects: SmProject[]): Record<string, unknown> {
  return {
    object: 'secret',
    id: secret.id,
    organizationId: secret.orgId,
    key: secret.keyEncrypted,
    creationDate: secret.createdAt,
    revisionDate: secret.revisionDate,
    projects: projects.map(projectToResponse),
  };
}

/** 单个 secret（含值）—— 只给 `get-by-ids` 与单取用。 */
function secretDetail(secret: SmSecret, projects: SmProject[]): Record<string, unknown> {
  return { ...secretSummary(secret, projects), value: secret.valueEncrypted, note: secret.noteEncrypted };
}

/**
 * 落在给定 project 集合里的 secret；`allowed` 为 `null` 表示不受 project 限制（owner）。
 *
 * ⚠️ owner 用 `all`（候选集）而不是 `links`：删掉一个 project 会让机密失去归属（关联被
 * 级联删除、本体保留），若按关联过滤，这些机密会从界面上凭空消失。
 * 机器账号仍然严格按 project 过滤：`links` 是**内连接**，未分配的机密对它不可见。
 */
function secretsInProjects(
  links: Map<string, string[]>,
  allowed: ReadonlySet<string> | null,
  all: readonly string[]
): Set<string> {
  if (allowed === null) return new Set(all);
  const selected = new Set<string>();
  for (const [secretId, projectIds] of links) {
    if (projectIds.some((projectId) => allowed.has(projectId))) selected.add(secretId);
  }
  return selected;
}

/** 把「主体」翻译成推送参数：两条认证路都有 org，只有 Web 会话那路有 userId（程序侧交给通知层反查）。 */
function broadcastSmChange(
  env: Env,
  request: Request,
  principal: SmPrincipal,
  kind: SmRealtimeKind
): void {
  broadcastSecretsManagerChange({
    env,
    request,
    organizationId: principal.organizationId,
    userId: principal.kind === 'user' ? principal.userId : null,
    kind,
  });
}

/** 本主体可见 / 可写的 secret；两个包装只为让调用点读起来是「可见 / 可写」。 */
function visibleSecretIds(
  principal: SmPrincipal,
  links: Map<string, string[]>,
  all: readonly string[]
): Set<string> {
  return secretsInProjects(links, grantedProjectIds(principal), all);
}

function writableSecretIds(
  principal: SmPrincipal,
  links: Map<string, string[]>,
  all: readonly string[]
): Set<string> {
  return secretsInProjects(links, writableProjectIds(principal), all);
}

/** 组织内 project 的 id → 对象映射（组内 project 数量有限，一次查齐）。 */
async function projectMap(env: Env, principal: SmPrincipal): Promise<Map<string, SmProject>> {
  const projects = await listProjects(env.DB, principal.organizationId);
  return new Map(projects.map((project) => [project.id, project]));
}

function linkedProjects(projectsById: Map<string, SmProject>, projectIds: readonly string[]): SmProject[] {
  return projectIds.map((id) => projectsById.get(id)).filter((project): project is SmProject => !!project);
}

/**
 * 校验并规范化 `projectIds`：**省略** ⇒ `ids: null`（不改关联，对应官方 `Option<Vec<Uuid>>`）；
 * **显式 `[]`** ⇒ 清空关联（机密变成「未分配」）；非法 ⇒ `ok: false`。
 *
 * ⚠️ 写权限不能省：只读的机器账号不得把 secret 建进 / 挪进它没授权的 project ——
 * project 授权是可见性的唯一依据，越权关联会让它立刻对该 project 的持有者可见。
 */
type ProjectIdsResolution = { ok: true; ids: string[] | null } | { ok: false };

async function resolveProjectIds(
  env: Env,
  principal: SmPrincipal,
  raw: unknown
): Promise<ProjectIdsResolution> {
  if (raw === undefined || raw === null) return { ok: true, ids: null };
  if (!Array.isArray(raw)) return { ok: false };

  const writable = writableProjectIds(principal);
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item) return { ok: false };
    if (writable !== null && !writable.has(item)) return { ok: false };
    const project = await getProject(env.DB, principal.organizationId, item);
    if (!project) return { ok: false };
    if (!ids.includes(item)) ids.push(item);
  }
  return { ok: true, ids };
}

async function handleOrgProjects(request: Request, env: Env, principal: SmPrincipal, method: string): Promise<Response> {
  if (method === 'GET') {
    const projects = await listProjects(env.DB, principal.organizationId);
    // 严格按授权过滤：未授权的 project 对 CLI 就等于不存在
    const visible = projects.filter((project) => permissionForProject(principal, project.id) !== null);
    return jsonResponse({ data: visible.map(projectToResponse) });
  }

  if (method === 'POST') {
    const body = (await readJson(request)) as { name?: unknown } | null;
    if (!isEncString(body?.name, 4096)) return errorResponse('name must be an EncString of type 2', 400);

    const now = new Date().toISOString();
    const project: SmProject = {
      id: generateUUID(),
      orgId: principal.organizationId,
      nameEncrypted: body.name,
      createdAt: now,
      revisionDate: now,
    };
    await createProject(env.DB, project);
    // 官方规则：建 project 的人自动成为它的 read-write 成员（owner 本就对整个组织可写）
    if (principal.kind === 'machine') {
      await setMachineAccountGrant(env.DB, principal.machineAccountId, project.id, 'write');
    }
    broadcastSmChange(env, request, principal, 'secrets');
    await recordSecretsEvents({
      db: env.DB,
      request,
      actor: eventActorOf(principal),
      typeCode: SmEventType.ProjectCreated,
      targets: [{ projectId: project.id }],
    });
    return jsonResponse(projectToResponse(project));
  }

  return errorResponse('Method not allowed', 405);
}

/** 取出**本主体可见**的 project；不可见与不存在一律 404（不给出存在性线索）。 */
async function resolveVisibleProject(
  env: Env,
  principal: SmPrincipal,
  rawId: string,
  required: 'read' | 'write'
): Promise<SmProject | Response> {
  const project = await getProject(env.DB, principal.organizationId, decodeURIComponent(rawId));
  if (!project) return errorResponse('Not found', 404);
  const permission = permissionForProject(principal, project.id);
  if (permission === null) return errorResponse('Not found', 404);
  if (required === 'write' && permission !== 'write') return errorResponse('Forbidden', 403);
  return project;
}

/** 本主体被授权的 project（列表信封里的 `projects[]` 只给这些）。 */
function grantedProjects(principal: SmPrincipal, projectsById: Map<string, SmProject>): SmProject[] {
  return [...projectsById.values()].filter((project) => permissionForProject(principal, project.id) !== null);
}

/**
 * `note` 必须是合法密文 —— **连空备注也要是「空串的 EncString」**。
 *
 * ⚠️ 不能把空串直接存进去：官方客户端（`bws` / 各语言 SDK）读到的每个 secret 都会把
 * key / value / note 当作 EncString 解析，存进空串会让**整个列表**当场报错，不是只丢一条备注。
 */
function isNoteField(value: unknown): boolean {
  return isEncString(value, MAX_NOTE_CIPHER_LENGTH);
}

/**
 * 列表信封：`{object, secrets[], projects[]}` —— 官方 `SecretWithProjectsListResponseModel`，
 * `bws` 按它解析（内层 `projects[]` 是必读的，不能只给 projectIds）。
 *
 * ⚠️ 批量删用的是另一个信封 `{object, data:[{id, error}]}`，两者形状不同，不可互换。
 */
async function listSecretsResponse(env: Env, principal: SmPrincipal, onlyProjectId?: string): Promise<Response> {
  const secrets = onlyProjectId
    ? await listProjectSecrets(env.DB, principal.organizationId, onlyProjectId)
    : await listOrgSecrets(env.DB, principal.organizationId);
  const links = await listSecretProjectIds(env.DB, principal.organizationId);
  const visible = visibleSecretIds(principal, links, secrets.map((secret) => secret.id));
  const projectsById = await projectMap(env, principal);

  const data = secrets
    .filter((secret) => visible.has(secret.id))
    .map((secret) => secretSummary(secret, linkedProjects(projectsById, links.get(secret.id) ?? [])));

  return jsonResponse({
    object: 'list',
    secrets: data,
    projects: grantedProjects(principal, projectsById).map(projectToResponse),
  });
}

async function createSecretResponse(request: Request, env: Env, principal: SmPrincipal): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (
    !isEncString(body?.key, MAX_KEY_CIPHER_LENGTH) ||
    !isEncString(body?.value, MAX_VALUE_CIPHER_LENGTH) ||
    !isNoteField(body?.note)
  ) {
    return errorResponse('key, value and note must be EncStrings of type 2', 400);
  }

  const resolved = await resolveProjectIds(env, principal, body?.projectIds);
  if (!resolved.ok) return errorResponse('projectIds must reference projects in this organization', 400);
  // 「未分配」是**允许**的（官方 `project_ids` 同样可选）：这类机密只对 Web 会话可见 ——
  // 机器账号的可见性按 project 授权过滤，看不到它。
  const projectIds = resolved.ids ?? [];

  const now = new Date().toISOString();
  const secret: SmSecret = {
    id: generateUUID(),
    orgId: principal.organizationId,
    keyEncrypted: body!.key as string,
    valueEncrypted: body!.value as string,
    noteEncrypted: (body!.note as string | undefined) ?? '',
    // 官方线格式没有标签字段 ⇒ 从 CLI / SDK 建的机密一律未打标签（只有 Web 端能设）。
    tagEncrypted: null,
    createdAt: now,
    revisionDate: now,
    deletedAt: null,
  };
  await createSecret(env.DB, secret);
  await setSecretProjects(env.DB, secret.id, projectIds);
  broadcastSmChange(env, request, principal, 'secrets');
  await recordSecretsEvents({
    db: env.DB,
    request,
    actor: eventActorOf(principal),
    typeCode: SmEventType.SecretCreated,
    targets: [{ secretId: secret.id }],
  });

  return jsonResponse(secretDetail(secret, linkedProjects(await projectMap(env, principal), projectIds)));
}

/** `POST /api/secrets/get-by-ids`：值 / 备注走这里单独取（列表里没有）。 */
async function getSecretsByIdsResponse(request: Request, env: Env, principal: SmPrincipal): Promise<Response> {
  const body = (await readJson(request)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids)) return errorResponse('Body must be {ids: [...]}', 400);

  const links = await listSecretProjectIds(env.DB, principal.organizationId);
  const visible = visibleSecretIds(
    principal,
    links,
    body.ids.filter((id): id is string => typeof id === 'string')
  );
  const projectsById = await projectMap(env, principal);

  const data: Array<Record<string, unknown>> = [];
  const retrievedIds: string[] = [];
  for (const raw of body.ids) {
    // 不可见的**直接跳过**（不报错，避免成为存在性探针）
    if (typeof raw !== 'string' || !visible.has(raw)) continue;
    const secret = await getSecretById(env.DB, principal.organizationId, raw);
    if (!secret || secret.deletedAt) continue;
    data.push(secretDetail(secret, linkedProjects(projectsById, links.get(raw) ?? [])));
    retrievedIds.push(secret.id);
  }
  // 「读过」是审计里最有价值的一类（`bws secret list` 就走这条）⇒ 逐条记
  await recordSecretsEvents({
    db: env.DB,
    request,
    actor: eventActorOf(principal),
    typeCode: SmEventType.SecretRetrieved,
    targets: retrievedIds.map((secretId) => ({ secretId })),
  });
  return jsonResponse({ data });
}

async function deleteSecretsResponse(request: Request, env: Env, principal: SmPrincipal): Promise<Response> {
  // ⚠️ 请求体是**裸 id 数组**，不是 `{ids: []}`
  const body = await readJson(request);
  if (!Array.isArray(body)) return errorResponse('Body must be an array of secret ids', 400);

  const links = await listSecretProjectIds(env.DB, principal.organizationId);
  const requestedIds = body.filter((id): id is string => typeof id === 'string');
  const visible = visibleSecretIds(principal, links, requestedIds);
  const writable = writableSecretIds(principal, links, requestedIds);
  const results: Array<Record<string, unknown>> = [];
  const deletedIds: string[] = [];
  const deletedAt = new Date().toISOString();

  for (const raw of body) {
    const id = typeof raw === 'string' ? raw : '';
    if (!id) {
      results.push(batchResult(String(raw), 'Invalid secret id'));
      continue;
    }
    if (!writable.has(id)) {
      // 可见但只读 → Forbidden；根本看不见 → Not found（与单取/改名的语义保持一致）
      results.push(batchResult(id, visible.has(id) ? 'Forbidden' : 'Not found'));
      continue;
    }
    // 软删（进 Trash）；满 30 天由已有的 scheduled 任务清理
    await softDeleteSecrets(env.DB, principal.organizationId, [id], deletedAt);
    deletedIds.push(id);
    results.push(batchResult(id, null));
  }
  broadcastSmChange(env, request, principal, 'secrets');
  await recordSecretsEvents({
    db: env.DB,
    request,
    actor: eventActorOf(principal),
    typeCode: SmEventType.SecretDeleted,
    targets: deletedIds.map((secretId) => ({ secretId })),
  });
  return jsonResponse({ object: 'list', data: results });
}

/**
 * 增量同步：`{hasChanges, secrets?}`。
 *
 * ⚠️ 三个形状坑（真机实测，官方 SDK 会在每一处报错）：① `lastSyncedDate` **可省**
 * （官方模型是 `Option`；省略 = 客户端从未同步 ⇒ 回全量），把它当必填会让官方客户端直接吃 400；
 * ② `secrets` 是**列表信封**，不是裸数组；③ 元素是**含值**的完整记录 —— 给列表摘要会直接抛错。
 *
 * 线格式没有「已删除」标记 ⇒ 只回活着的行，软删的靠列表自然消失。
 */
async function syncSecretsResponse(request: Request, env: Env, principal: SmPrincipal): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('lastSyncedDate') ?? '';
  let since: string | null = null;
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return errorResponse('lastSyncedDate must be an RFC3339 timestamp', 400);
    since = new Date(parsed).toISOString();
  }

  const links = await listSecretProjectIds(env.DB, principal.organizationId);
  const projectsById = await projectMap(env, principal);
  const candidates =
    since === null
      ? await listOrgSecrets(env.DB, principal.organizationId)
      : await listSecretsChangedSince(env.DB, principal.organizationId, since);

  const changed = candidates.filter(
    (secret) => !secret.deletedAt && visibleSecretIds(principal, links, [secret.id]).has(secret.id)
  );
  if (changed.length === 0) return jsonResponse({ hasChanges: false });

  return jsonResponse({
    hasChanges: true,
    secrets: {
      data: changed.map((secret) => secretDetail(secret, linkedProjects(projectsById, links.get(secret.id) ?? []))),
    },
  });
}

async function handleSecretById(
  request: Request,
  env: Env,
  principal: SmPrincipal,
  rawId: string,
  method: string
): Promise<Response> {
  const id = decodeURIComponent(rawId);
  const links = await listSecretProjectIds(env.DB, principal.organizationId);
  const projectsById = await projectMap(env, principal);

  if (method === 'GET') {
    if (!visibleSecretIds(principal, links, [id]).has(id)) return errorResponse('Not found', 404);
    const secret = await getSecretById(env.DB, principal.organizationId, id);
    if (!secret || secret.deletedAt) return errorResponse('Not found', 404);
    await recordSecretsEvents({
      db: env.DB,
      request,
      actor: eventActorOf(principal),
      typeCode: SmEventType.SecretRetrieved,
      targets: [{ secretId: id }],
    });
    return jsonResponse(secretDetail(secret, linkedProjects(projectsById, links.get(id) ?? [])));
  }

  if (method === 'PUT' || method === 'POST') {
    if (!visibleSecretIds(principal, links, [id]).has(id)) return errorResponse('Not found', 404);
    if (!writableSecretIds(principal, links, [id]).has(id)) return errorResponse('Forbidden', 403);
    const existing = await getSecretById(env.DB, principal.organizationId, id);
    if (!existing || existing.deletedAt) return errorResponse('Not found', 404);

    const body = (await readJson(request)) as Record<string, unknown> | null;
    if (
      !isEncString(body?.key, MAX_KEY_CIPHER_LENGTH) ||
      !isEncString(body?.value, MAX_VALUE_CIPHER_LENGTH) ||
      !isNoteField(body?.note)
    ) {
      return errorResponse('key, value and note must be EncStrings of type 2', 400);
    }

    // 省略 `projectIds` = 不改关联；显式 `[]` = 清空（变成「未分配」）
    const resolved = await resolveProjectIds(env, principal, body?.projectIds);
    if (!resolved.ok) return errorResponse('projectIds must reference projects in this organization', 400);

    const revisionDate = new Date().toISOString();
    const updated: SmSecret = {
      ...existing,
      keyEncrypted: body!.key as string,
      valueEncrypted: body!.value as string,
      noteEncrypted: (body!.note as string | undefined) ?? '',
      revisionDate,
    };
    await updateSecret(env.DB, updated);
    if (resolved.ids !== null) await setSecretProjects(env.DB, id, resolved.ids);
    broadcastSmChange(env, request, principal, 'secrets');
    await recordSecretsEvents({
      db: env.DB,
      request,
      actor: eventActorOf(principal),
      typeCode: SmEventType.SecretEdited,
      targets: [{ secretId: id }],
    });

    const nextLinks = resolved.ids ?? links.get(id) ?? [];
    return jsonResponse(secretDetail(updated, linkedProjects(projectsById, nextLinks)));
  }

  return errorResponse('Method not allowed', 405);
}

/**
 * `bws` 那一侧：`Authorization: Bearer <SM JWT>`。
 *
 * 令牌不是 SM 令牌时返回 `null`（**不是** 401）—— 放行给用户令牌闸门，Web 会话走的正是那条路。
 */
export async function handleSecretsApiRoute(
  request: Request,
  env: Env,
  path: string,
  method: string
): Promise<Response | null> {
  if (!isSecretsApiPath(path)) return null;

  const resolved = await resolveSecretsPrincipal(env, request.headers.get('Authorization'));
  if (resolved.kind === 'none') return null;
  // SM 令牌但已不可用（机器账号被删 / 属主被封禁）—— 必须在这里拒掉，不能放行给与 SM 无关的用户令牌闸门
  if (resolved.kind === 'invalid') return errorResponse('Unauthorized', 401);

  return handleSecretsApiRouteWithPrincipal(request, env, resolved.principal, path, method);
}

/** Web 会话那一侧（在用户令牌闸门之后调用，因此享受常规限流）。 */
export async function handleSecretsApiRouteForUser(
  request: Request,
  env: Env,
  userId: string,
  path: string,
  method: string
): Promise<Response | null> {
  if (!isSecretsApiPath(path)) return null;

  const principal = await resolveSecretsUserPrincipal(env, userId);
  if (!principal) return errorResponse('Not found', 404);

  return handleSecretsApiRouteWithPrincipal(request, env, principal, path, method);
}

async function handleSecretsApiRouteWithPrincipal(
  request: Request,
  env: Env,
  principal: SmPrincipal,
  path: string,
  method: string
): Promise<Response | null> {
  const orgProjects = path.match(ORG_PROJECTS_PATH);
  if (orgProjects) {
    // 路径里的组织必须属于当前主体，否则等于横向访问别人的组织
    if (decodeURIComponent(orgProjects[1]) !== principal.organizationId) return errorResponse('Not found', 404);
    return handleOrgProjects(request, env, principal, method);
  }

  if (path === PROJECTS_DELETE_PATH && method === 'POST') {
    const body = await readJson(request);
    if (!Array.isArray(body)) return errorResponse('Body must be an array of project ids', 400);

    const results: Array<Record<string, unknown>> = [];
    const deletedProjectIds: string[] = [];
    for (const rawId of body) {
      const id = typeof rawId === 'string' ? rawId : '';
      if (!id) {
        results.push(batchResult(String(rawId), 'Invalid project id'));
        continue;
      }
      const project = await getProject(env.DB, principal.organizationId, id);
      if (!project || permissionForProject(principal, id) !== 'write') {
        results.push(batchResult(id, 'Not found'));
        continue;
      }
      // 硬删；它名下的 secret 只是断开关联（关联表级联删行），本体不跟着消失
      await deleteProject(env.DB, principal.organizationId, id);
      deletedProjectIds.push(id);
      results.push(batchResult(id, null));
    }
    broadcastSmChange(env, request, principal, 'secrets');
    await recordSecretsEvents({
      db: env.DB,
      request,
      actor: eventActorOf(principal),
      typeCode: SmEventType.ProjectDeleted,
      targets: deletedProjectIds.map((projectId) => ({ projectId })),
    });
    return jsonResponse({ object: 'list', data: results });
  }

  const projectMatch = path.match(PROJECT_PATH);
  if (projectMatch) {
    if (method === 'GET') {
      const project = await resolveVisibleProject(env, principal, projectMatch[1], 'read');
      if (project instanceof Response) return project;
      return jsonResponse(projectToResponse(project));
    }

    if (method === 'PUT' || method === 'POST') {
      const project = await resolveVisibleProject(env, principal, projectMatch[1], 'write');
      if (project instanceof Response) return project;

      const body = (await readJson(request)) as { name?: unknown } | null;
      if (!isEncString(body?.name, 4096)) return errorResponse('name must be an EncString of type 2', 400);

      const revisionDate = new Date().toISOString();
      await updateProjectName(env.DB, principal.organizationId, project.id, body.name, revisionDate);
      broadcastSmChange(env, request, principal, 'secrets');
      await recordSecretsEvents({
        db: env.DB,
        request,
        actor: eventActorOf(principal),
        typeCode: SmEventType.ProjectEdited,
        targets: [{ projectId: project.id }],
      });
      return jsonResponse(projectToResponse({ ...project, nameEncrypted: body.name, revisionDate }));
    }

    return errorResponse('Method not allowed', 405);
  }

  // ── secrets ────────────────────────────────────────────────────────────────
  // ⚠️ 带 id 的路径要放在 `get-by-ids` / `delete` **之后**，否则会被当成 id 吞掉。
  const orgSecrets = path.match(ORG_SECRETS_PATH);
  if (orgSecrets) {
    if (decodeURIComponent(orgSecrets[1]) !== principal.organizationId) return errorResponse('Not found', 404);
    if (method === 'GET') return listSecretsResponse(env, principal);
    if (method === 'POST') return createSecretResponse(request, env, principal);
    return errorResponse('Method not allowed', 405);
  }

  const orgSecretsSync = path.match(ORG_SECRETS_SYNC_PATH);
  if (orgSecretsSync) {
    if (decodeURIComponent(orgSecretsSync[1]) !== principal.organizationId) return errorResponse('Not found', 404);
    if (method !== 'GET') return errorResponse('Method not allowed', 405);
    return syncSecretsResponse(request, env, principal);
  }

  const projectSecrets = path.match(PROJECT_SECRETS_PATH);
  if (projectSecrets) {
    if (method !== 'GET') return errorResponse('Method not allowed', 405);
    // 按 project 列之前，先确认这个 project 对当前主体可见
    const project = await resolveVisibleProject(env, principal, projectSecrets[1], 'read');
    if (project instanceof Response) return project;
    return listSecretsResponse(env, principal, project.id);
  }

  if (path === SECRETS_GET_BY_IDS_PATH) {
    if (method !== 'POST') return errorResponse('Method not allowed', 405);
    return getSecretsByIdsResponse(request, env, principal);
  }

  if (path === SECRETS_DELETE_PATH) {
    if (method !== 'POST') return errorResponse('Method not allowed', 405);
    return deleteSecretsResponse(request, env, principal);
  }

  const secretMatch = path.match(SECRET_PATH);
  if (secretMatch) return handleSecretById(request, env, principal, secretMatch[1], method);

  return null;
}

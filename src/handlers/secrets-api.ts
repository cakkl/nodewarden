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
import { permissionForProject, resolveSecretsPrincipal, type SmPrincipal } from '../services/secrets-access';
import { errorResponse, jsonResponse } from '../utils/response';
import { generateUUID } from '../utils/uuid';
import { isEncString } from './secrets-shared';

/**
 * 官方形态的机密管理器端点（`bws` 用的那套）。
 *
 * ⚠️ 鉴权是**机器账号令牌**（`Authorization: Bearer <SM JWT>`），与 Web 会话是两条独立的路：
 * 这些端点必须在 `router.ts` 的用户令牌闸门**之前**分流，否则 SM 令牌会先被当成坏的用户
 * 令牌 401 掉。
 *
 * ⚠️ 三种包裹层**互不一致**（照官方，别顺手「统一」）：projects 列表是 `{data:[...]}`、
 * secrets 列表是 `{object, secrets[], projects[]}`、批量删返回 `[{id, error}]`。Rust 端是
 * 强类型 serde，少一个必填字段就整条解析失败。
 *
 * 权限（决策 3，Web 与 CLI 同一套）：按 project 严格过滤；读要 `read`，改/删要 `write`。
 * ⚠️ 照抄官方那条怪规则：**只读的机器账号也能建 project**（它建完自动获得该 project 的
 * write —— 否则它连自己刚建的东西都看不见）。
 */

const ORG_PROJECTS_PATH = /^\/api\/organizations\/([^/]+)\/projects$/;
const PROJECT_PATH = /^\/api\/projects\/([^/]+)$/;
const PROJECTS_DELETE_PATH = '/api/projects/delete';

/** 本模块接管的路径（其余交回 `router.ts` 的用户令牌流程）。 */
function isSecretsApiPath(path: string): boolean {
  return ORG_PROJECTS_PATH.test(path) || PROJECT_PATH.test(path) || path === PROJECTS_DELETE_PATH;
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
    // 官方规则：建 project 的人自动成为它的 read-write 成员
    await setMachineAccountGrant(env.DB, principal.machineAccountId, project.id, 'write');
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

export async function handleSecretsApiRoute(
  request: Request,
  env: Env,
  path: string,
  method: string
): Promise<Response | null> {
  if (!isSecretsApiPath(path)) return null;

  const principal = await resolveSecretsPrincipal(env, request.headers.get('Authorization'));
  if (!principal) return errorResponse('Unauthorized', 401);

  const orgProjects = path.match(ORG_PROJECTS_PATH);
  if (orgProjects) {
    // 路径里的组织必须是令牌自己的组织，否则等于横向访问别人的组织
    if (decodeURIComponent(orgProjects[1]) !== principal.organizationId) return errorResponse('Not found', 404);
    return handleOrgProjects(request, env, principal, method);
  }

  if (path === PROJECTS_DELETE_PATH && method === 'POST') {
    const body = await readJson(request);
    if (!Array.isArray(body)) return errorResponse('Body must be an array of project ids', 400);

    const results: Array<Record<string, unknown>> = [];
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
      results.push(batchResult(id, null));
    }
    return jsonResponse(results);
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
      return jsonResponse(projectToResponse({ ...project, nameEncrypted: body.name, revisionDate }));
    }

    return errorResponse('Method not allowed', 405);
  }

  return null;
}

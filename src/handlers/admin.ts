import { Env, User, Invite } from '../types';
import { AuthService } from '../services/auth';
import { StorageService } from '../services/storage';
import { jsonResponse, errorResponse } from '../utils/response';
import { deleteBlobObject, getAttachmentObjectKey, getSendFileObjectKey } from '../services/blob-store';
import { auditRequestMetadata, getAuditLogSettings, normalizeAuditLogSettings, saveAuditLogSettings, writeAuditEvent } from '../services/audit-events';

function isAdmin(user: User): boolean {
  return user.role === 'admin' && user.status === 'active';
}

/** 英文原文同时也是 `webapp/src/lib/i18n.ts` 映射表的键（改动必须两边同步） */
const LAST_ACTIVE_ADMIN_MESSAGE = 'This is the last active administrator. Promote another user first.';

/**
 * 管理端**写**操作前用库里的最新状态复核操作者。
 *
 * 为什么需要：`actorUser` 来自 `AuthService` 的 isolate 级缓存（TTL 15 s，见
 * `AUTH_CONTEXT_CACHE_TTL_MS`），而 ban / 删除只清**当前 isolate** 的缓存 ——
 * 其余 isolate 上「刚被别的管理员 ban 掉的人」还能按 active 管理员继续操作最多 15 s。
 * 管理端写操作本来极低频，多一次主键查询换掉这个窗口很划算。
 */
async function resolveFreshAdmin(storage: StorageService, actorUser: User): Promise<User | null> {
  const fresh = await storage.getUserById(actorUser.id);
  return fresh && isAdmin(fresh) ? fresh : null;
}

/**
 * 「最后一个还能用的管理员」保护。
 *
 * 为什么不变量不显然：能走到这里的操作者本身必须是 active 管理员，而各 handler 都有
 * 「不能对自己动手」的检查 ⇒ 单看代码似乎永远归不到零。但有两个漏口：
 *   ① 上面的 15 s 缓存窗口（A 被 B ban 后，A 仍可能以管理员身份删/封 B）；
 *   ② 将来新增的批量操作 / 恢复流程。
 * 一旦归零，`ensureAdminUserExists()` 要等下次 schema 重建才兜底，而恢复归档会立刻触发 ——
 * 也就是「把别人的备份恢复进来」会静默决定谁成为管理员。所以把不变量写成显式断言。
 *
 * 导出**仅为可测试性**：handler 路径上它当前不可达（操作者自己就是 active 管理员 ⇒
 * 计数至少为 2，或者命中「不能对自己动手」），所以只能直接对它做单测。
 */
export async function guardLastActiveAdmin(storage: StorageService, target: User): Promise<Response | null> {
  // 只有「移除一个还能用的管理员」才有风险：把 user 改成 banned、把 banned 恢复成 active 都安全。
  if (target.role !== 'admin' || target.status !== 'active') return null;
  const activeAdmins = await storage.countActiveAdmins();
  if (activeAdmins > 1) return null;
  return errorResponse(LAST_ACTIVE_ADMIN_MESSAGE, 400);
}

/** 管理员敏感写操作前的主密码复核。导出供 `admin-mail.ts`（SMTP 凭证）复用。 */
export async function requireMasterPasswordHash(
  env: Env,
  actorUser: User,
  masterPasswordHash: unknown
): Promise<Response | null> {
  const normalized = String(masterPasswordHash || '').trim();
  if (!normalized) {
    return errorResponse('masterPasswordHash is required', 400);
  }
  const auth = new AuthService(env);
  const valid = await auth.verifyPassword(normalized, actorUser.masterPasswordHash, actorUser.email);
  if (!valid) {
    return errorResponse('Invalid password', 400);
  }
  return null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data).map(v => v.toString(16).padStart(2, '0')).join('');
}

function buildInviteLink(request: Request, code: string): string {
  const url = new URL(request.url);
  return `${url.origin}/?invite=${encodeURIComponent(code)}`;
}

async function writeAuditLog(
  storage: StorageService,
  actorUserId: string | null,
  action: string,
  targetType: string | null,
  targetId: string | null,
  metadata: Record<string, unknown> | null,
  request?: Request
): Promise<void> {
  await writeAuditEvent(storage, {
    actorUserId,
    action,
    targetType,
    targetId,
    category: action.startsWith('admin.user.') ? 'security' : 'system',
    level: action.startsWith('admin.user.') ? 'security' : 'info',
    metadata: {
      ...(metadata || {}),
      ...(request ? auditRequestMetadata(request) : {}),
    },
  });
}

function toInviteResponse(request: Request, invite: Invite): Record<string, unknown> {
  return {
    code: invite.code,
    status: invite.status,
    createdBy: invite.createdBy,
    usedBy: invite.usedBy,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
    expiresAt: invite.expiresAt,
    inviteLink: buildInviteLink(request, invite.code),
    object: 'invite',
  };
}

// GET /api/admin/users
export async function handleAdminListUsers(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  void request;
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const storage = new StorageService(env.DB);
  // 曾经是：先取全部用户，再对**每个用户**调一次 countAccountPasskeyCredentialsByUserId()
  // —— 用户表有多大，就发多少条 SQL。列表只需要"有没有"，一次 DISTINCT 即可。
  const [users, twoFactorPasskeyUserIds] = await Promise.all([
    storage.getAllUsers(),
    storage.listAccountPasskeyUserIds('twoFactor'),
  ]);
  const data = users.map(user => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    twoFactorEnabled: !!user.totpSecret || Boolean(user.yubikeyKey1 || user.yubikeyKey2 || user.yubikeyKey3 || user.yubikeyKey4 || user.yubikeyKey5) || twoFactorPasskeyUserIds.has(user.id),
    creationDate: user.createdAt,
    revisionDate: user.updatedAt,
    object: 'user',
  }));
  return jsonResponse({
    data,
    object: 'list',
    continuationToken: null,
  });
}

// GET /api/admin/logs
export async function handleAdminListAuditLogs(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
  const category = String(url.searchParams.get('category') || '').trim() || null;
  const level = String(url.searchParams.get('level') || '').trim() || null;
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase() || null;
  const from = String(url.searchParams.get('from') || '').trim() || null;
  const to = String(url.searchParams.get('to') || '').trim() || null;

  const storage = new StorageService(env.DB);
  const result = await storage.listAuditLogs({ limit, offset, category, level, q, from, to });
  return jsonResponse({
    data: result.logs.map(log => ({
      id: log.id,
      actorUserId: log.actorUserId,
      actorEmail: log.actorEmail,
      action: log.action,
      category: log.category,
      level: log.level,
      targetType: log.targetType,
      targetId: log.targetId,
      targetUserEmail: log.targetUserEmail,
      metadata: log.metadata,
      createdAt: log.createdAt,
      object: 'auditLog',
    })),
    total: result.total,
    limit,
    offset,
    hasMore: result.hasMore,
    object: 'list',
    continuationToken: result.hasMore ? String(offset + result.logs.length) : null,
  });
}

// GET /api/admin/logs/settings
export async function handleAdminGetAuditLogSettings(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  void request;
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }
  const storage = new StorageService(env.DB);
  return jsonResponse({
    object: 'auditLogSettings',
    ...await getAuditLogSettings(storage),
  });
}

// PUT /api/admin/logs/settings
export async function handleAdminUpdateAuditLogSettings(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }
  const storage = new StorageService(env.DB);
  const settings = await saveAuditLogSettings(storage, normalizeAuditLogSettings(body));
  await writeAuditLog(storage, actorUser.id, 'admin.audit.settings.update', 'auditLog', null, { ...settings }, request);
  return jsonResponse({
    object: 'auditLogSettings',
    ...settings,
  });
}

// DELETE /api/admin/logs
export async function handleAdminClearAuditLogs(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }
  const storage = new StorageService(env.DB);
  const deleted = await storage.clearAuditLogs();
  await writeAuditLog(storage, actorUser.id, 'admin.audit.clear', 'auditLog', null, {
    deleted,
  }, request);
  return jsonResponse({ object: 'auditLogClear', deleted });
}

// POST /api/admin/invites
export async function handleAdminCreateInvite(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const storage = new StorageService(env.DB);
  const body = await readJsonBody(request);
  const passwordError = await requireMasterPasswordHash(env, actorUser, body.masterPasswordHash);
  if (passwordError) return passwordError;

  const expiresInHours = Number.isFinite(Number(body.expiresInHours))
    ? Math.max(1, Math.min(24 * 30, Math.floor(Number(body.expiresInHours))))
    : 24 * 7;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);
  const invite: Invite = {
    code: randomHex(20),
    createdBy: actorUser.id,
    usedBy: null,
    expiresAt: expiresAt.toISOString(),
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await storage.createInvite(invite);
  await writeAuditLog(storage, actorUser.id, 'admin.invite.create', 'invite', null, {
    expiresInHours,
  }, request);

  return jsonResponse(toInviteResponse(request, invite), 201);
}

// GET /api/admin/invites
export async function handleAdminListInvites(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const storage = new StorageService(env.DB);
  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('includeInactive') === 'true';
  const invites = await storage.listInvites(includeInactive);
  return jsonResponse({
    data: invites.map(invite => toInviteResponse(request, invite)),
    object: 'list',
    continuationToken: null,
  });
}

// DELETE /api/admin/invites/:code
export async function handleAdminDeleteInvite(
  request: Request,
  env: Env,
  actorUser: User,
  code: string
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const body = await readJsonBody(request);
  const passwordError = await requireMasterPasswordHash(env, actorUser, body.masterPasswordHash);
  if (passwordError) return passwordError;

  const storage = new StorageService(env.DB);
  const deleted = await storage.deleteInvite(code);
  if (!deleted) {
    return errorResponse('Invite not found', 404);
  }

  await writeAuditLog(storage, actorUser.id, 'admin.invite.delete', 'invite', null, {
    code,
  }, request);
  return new Response(null, { status: 204 });
}

// DELETE /api/admin/invites
export async function handleAdminDeleteAllInvites(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const body = await readJsonBody(request);
  const passwordError = await requireMasterPasswordHash(env, actorUser, body.masterPasswordHash);
  if (passwordError) return passwordError;

  const storage = new StorageService(env.DB);
  const url = new URL(request.url);
  if (url.searchParams.get('scope') === 'invalid') {
    const deleted = await storage.deleteInvalidInvites();
    await writeAuditLog(storage, actorUser.id, 'admin.invite.delete_invalid', 'invite', null, {
      deleted,
    }, request);

    return jsonResponse({ deleted }, 200);
  }

  const deleted = await storage.deleteAllInvites();
  await writeAuditLog(storage, actorUser.id, 'admin.invite.delete_all', 'invite', null, {
    deleted,
  }, request);

  return jsonResponse({ deleted }, 200);
}

// PUT /api/admin/users/:id/status
export async function handleAdminSetUserStatus(
  request: Request,
  env: Env,
  actorUser: User,
  targetUserId: string
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const storage = new StorageService(env.DB);
  const freshActor = await resolveFreshAdmin(storage, actorUser);
  if (!freshActor) {
    return errorResponse('Forbidden', 403);
  }

  const body = await readJsonBody(request);
  const passwordError = await requireMasterPasswordHash(env, freshActor, body.masterPasswordHash);
  if (passwordError) return passwordError;

  const nextStatus = body.status === 'banned' ? 'banned' : body.status === 'active' ? 'active' : null;
  if (!nextStatus) {
    return errorResponse('status must be active or banned', 400);
  }
  if (targetUserId === freshActor.id && nextStatus !== 'active') {
    return errorResponse('You cannot ban yourself', 400);
  }

  const target = await storage.getUserById(targetUserId);
  if (!target) {
    return errorResponse('User not found', 404);
  }

  if (nextStatus === 'banned') {
    const lastAdminError = await guardLastActiveAdmin(storage, target);
    if (lastAdminError) return lastAdminError;
  }

  target.status = nextStatus;
  target.updatedAt = new Date().toISOString();
  await storage.saveUser(target);
  if (nextStatus === 'banned') {
    await storage.deleteRefreshTokensByUserId(target.id);
  }
  AuthService.invalidateUserCache(target.id);
  await writeAuditLog(storage, freshActor.id, 'admin.user.status', 'user', target.id, {
    status: nextStatus,
  }, request);

  return jsonResponse({
    id: target.id,
    email: target.email,
    role: target.role,
    status: target.status,
    object: 'user',
  });
}

// DELETE /api/admin/users/:id
export async function handleAdminDeleteUser(
  request: Request,
  env: Env,
  actorUser: User,
  targetUserId: string
): Promise<Response> {
  if (!isAdmin(actorUser)) {
    return errorResponse('Forbidden', 403);
  }

  const storage = new StorageService(env.DB);
  const freshActor = await resolveFreshAdmin(storage, actorUser);
  if (!freshActor) {
    return errorResponse('Forbidden', 403);
  }
  if (targetUserId === freshActor.id) {
    return errorResponse('You cannot delete yourself', 400);
  }

  const body = await readJsonBody(request);
  const passwordError = await requireMasterPasswordHash(env, freshActor, body.masterPasswordHash);
  if (passwordError) return passwordError;

  const target = await storage.getUserById(targetUserId);
  if (!target) {
    return errorResponse('User not found', 404);
  }

  const lastAdminError = await guardLastActiveAdmin(storage, target);
  if (lastAdminError) return lastAdminError;

  // Clean up R2 files before DB cascade deletes the metadata rows.
  // 1. Attachment files (keyed by cipherId/attachmentId)
  const attachmentMap = await storage.getAttachmentsByUserId(target.id);
  for (const [cipherId, attachments] of attachmentMap) {
    for (const att of attachments) {
      await deleteBlobObject(env, getAttachmentObjectKey(cipherId, att.id));
    }
  }
  // 2. Send files (keyed by sends/sendId/fileId)
  const sends = await storage.getAllSends(target.id);
  for (const send of sends) {
    if (send.type === 1) { // SendType.File
      try {
        const parsed = JSON.parse(send.data) as Record<string, unknown>;
        const fileId = typeof parsed.id === 'string' ? parsed.id : null;
        if (fileId) {
          await deleteBlobObject(env, getSendFileObjectKey(send.id, fileId));
        }
      } catch { /* non-file send or bad data, skip */ }
    }
  }

  await storage.deleteRefreshTokensByUserId(target.id);
  await storage.deleteUserById(target.id);
  AuthService.invalidateUserCache(target.id);
  await writeAuditLog(storage, freshActor.id, 'admin.user.delete', 'user', target.id, {
    targetEmail: target.email,
  }, request);

  return new Response(null, { status: 204 });
}

import type { AdminInvite, AdminUser, AuditLogCategory, AuditLogEntry, AuditLogLevel, AuditLogListResult, AuditLogSettings, ListResponse } from '../types';
import { t } from '../i18n';
import { parseErrorMessage, parseJson, type AuthedFetch } from './shared';

export async function listAdminUsers(authedFetch: AuthedFetch): Promise<AdminUser[]> {
  const resp = await authedFetch('/api/admin/users');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_load_admin_data_failed')));
  const body = await parseJson<ListResponse<AdminUser>>(resp);
  return body?.data || [];
}

export async function listAdminInvites(authedFetch: AuthedFetch): Promise<AdminInvite[]> {
  const resp = await authedFetch('/api/admin/invites?includeInactive=true');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_load_admin_data_failed')));
  const body = await parseJson<ListResponse<AdminInvite>>(resp);
  return body?.data || [];
}

export async function createInvite(authedFetch: AuthedFetch, hours: number, masterPasswordHash: string): Promise<void> {
  const resp = await authedFetch('/api/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresInHours: hours, masterPasswordHash }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_create_invite_failed')));
}

export async function deleteInvite(authedFetch: AuthedFetch, code: string, masterPasswordHash: string): Promise<void> {
  const resp = await authedFetch(`/api/admin/invites/${encodeURIComponent(code)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPasswordHash }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_invite_failed')));
}

export async function deleteInvalidInvites(authedFetch: AuthedFetch, masterPasswordHash: string): Promise<void> {
  const resp = await authedFetch('/api/admin/invites?scope=invalid', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPasswordHash }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_invalid_invites_failed')));
}

export async function deleteAllInvites(authedFetch: AuthedFetch, masterPasswordHash: string): Promise<void> {
  const resp = await authedFetch('/api/admin/invites', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPasswordHash }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_all_invites_failed')));
}

export async function setUserStatus(
  authedFetch: AuthedFetch,
  userId: string,
  status: 'active' | 'banned',
  masterPasswordHash: string
): Promise<void> {
  const resp = await authedFetch(`/api/admin/users/${encodeURIComponent(userId)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, masterPasswordHash }),
  });
  // 这两条路径都要求主密码，且服务端有 if-not-self / 最后一个管理员的校验：
  // 丢掉服务端文案的话，用户输错密码也只会看到「更新失败」，无法自救。
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_update_user_status_failed')));
}

export async function deleteUser(authedFetch: AuthedFetch, userId: string, masterPasswordHash: string): Promise<void> {
  const resp = await authedFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPasswordHash }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_delete_user_failed')));
}

export interface AuditLogFilters {
  limit?: number;
  offset?: number;
  category?: AuditLogCategory | 'all';
  level?: AuditLogLevel | 'all';
  q?: string;
  from?: string;
  to?: string;
}

export async function listAuditLogs(authedFetch: AuthedFetch, filters: AuditLogFilters = {}): Promise<AuditLogListResult> {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit || 50));
  params.set('offset', String(filters.offset || 0));
  if (filters.category && filters.category !== 'all') params.set('category', filters.category);
  if (filters.level && filters.level !== 'all') params.set('level', filters.level);
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);

  const resp = await authedFetch(`/api/admin/logs?${params.toString()}`);
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_load_logs_failed')));
  const body = await parseJson<ListResponse<AuditLogEntry>>(resp);
  return {
    logs: body?.data || [],
    total: body?.total || 0,
    limit: body?.limit || filters.limit || 50,
    offset: body?.offset || filters.offset || 0,
    hasMore: !!body?.hasMore,
  };
}

export async function getAuditLogSettings(authedFetch: AuthedFetch): Promise<AuditLogSettings> {
  const resp = await authedFetch('/api/admin/logs/settings');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_load_log_settings_failed')));
  const body = await parseJson<AuditLogSettings & { object?: string }>(resp);
  return {
    retentionDays: body?.retentionDays ?? null,
    maxEntries: body?.maxEntries ?? null,
  };
}

export async function saveAuditLogSettings(authedFetch: AuthedFetch, settings: AuditLogSettings): Promise<AuditLogSettings> {
  const resp = await authedFetch('/api/admin/logs/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_log_settings_save_failed')));
  const body = await parseJson<AuditLogSettings & { object?: string }>(resp);
  return {
    retentionDays: body?.retentionDays ?? null,
    maxEntries: body?.maxEntries ?? null,
  };
}

export async function clearAuditLogs(authedFetch: AuthedFetch): Promise<number> {
  const resp = await authedFetch('/api/admin/logs', { method: 'DELETE' });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_clear_logs_failed')));
  const body = await parseJson<{ deleted?: number }>(resp);
  return Number(body?.deleted || 0);
}

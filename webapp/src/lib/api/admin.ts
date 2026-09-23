import type { AdminInvite, AdminUser, AuditLogCategory, AuditLogEntry, AuditLogLevel, AuditLogListResult, AuditLogSettings, ListResponse, MailSettings, MailSettingsInput, MailTestResult } from '../types';
import { t, translateServerError } from '../i18n';
import { parseErrorMessage, parseJson, type AuthedFetch } from './shared';

/**
 * 投递失败。保留服务端的结构化字段，让界面能按「哪个环节 + 什么状态码」
 * 挑本地化文案 —— 服务端回复里的 5xx 详情是动态的，整串匹配不了。
 */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly stage: string | null,
    readonly code: number | null,
    readonly timedOut: boolean
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

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

function normalizeMailSettings(raw: unknown): MailSettings {
  const body = (raw || {}) as Record<string, unknown>;
  const encryption = String(body.encryption || '').toLowerCase() === 'implicit' ? 'implicit' : 'starttls';
  return {
    enabled: !!(body.enabled ?? body.Enabled),
    host: String(body.host ?? body.Host ?? ''),
    port: Number(body.port ?? body.Port ?? 587),
    encryption,
    username: String(body.username ?? body.Username ?? ''),
    fromAddress: String(body.fromAddress ?? body.FromAddress ?? ''),
    fromName: String(body.fromName ?? body.FromName ?? ''),
    passwordConfigured: !!(body.passwordConfigured ?? body.PasswordConfigured),
    configured: !!(body.configured ?? body.Configured),
  };
}

export async function getMailSettings(authedFetch: AuthedFetch): Promise<MailSettings> {
  const resp = await authedFetch('/api/admin/mail/settings');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_mail_settings_load_failed')));
  return normalizeMailSettings(await parseJson<unknown>(resp));
}

export async function saveMailSettings(
  authedFetch: AuthedFetch,
  settings: MailSettingsInput,
  masterPasswordHash: string
): Promise<MailSettings> {
  const resp = await authedFetch('/api/admin/mail/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, masterPasswordHash }),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_mail_settings_save_failed')));
  return normalizeMailSettings(await parseJson<unknown>(resp));
}

/** 用**表单当前值**发一封测试邮件到操作者自己的邮箱（未保存也能测，不需要主密码）。 */
export async function sendTestMail(
  authedFetch: AuthedFetch,
  settings: MailSettingsInput
): Promise<MailTestResult> {
  const resp = await authedFetch('/api/admin/mail/settings/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!resp.ok) {
    // 只能读一次 body：`parseJson` 与 `parseErrorMessage` 都会消费流，
    // 两者相继调用会抛 `body stream already read`，把真正的错误掩盖掉。
    const raw = await resp.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const detail = String(body?.error_description || body?.error || body?.Message || '').trim();
    throw new MailDeliveryError(
      translateServerError(detail, t('txt_mail_test_failed')),
      body?.smtpStage ? String(body.smtpStage) : null,
      body?.smtpCode === null || body?.smtpCode === undefined ? null : Number(body.smtpCode),
      !!body?.timedOut
    );
  }
  const body = (await parseJson<Record<string, unknown>>(resp)) || {};
  return {
    recipient: String(body.recipient || ''),
    authMethod: String(body.authMethod || '').toLowerCase() === 'login' ? 'login' : 'plain',
    encryption: String(body.encryption || '').toLowerCase() === 'implicit' ? 'implicit' : 'starttls',
    response: String(body.response || ''),
  };
}

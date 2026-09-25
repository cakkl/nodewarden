/**
 * 用户级「语言 / 时区」偏好。
 *
 * 只要求登录，不需要管理员。`locale` 与界面语言是**同一个值**：保存后既应用到 i18n，
 * 也落库给邮件用。
 *
 * 只导出界面用到的两个：读走 `detect`（登录时顺带上报检测值，返回值即最新偏好），
 * 写走 `save`；`GET` 端点留给调试与将来的客户端。
 */
import { t } from '../i18n';
import { parseErrorMessage, parseJson, type AuthedFetch } from './shared';
import type { MailPreferences, MailPreferencesDetectResult, MailPreferencesUpdate } from '../types';

function normalizePreferences(raw: unknown): MailPreferences {
  const body = (raw || {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed : null;
  };
  return {
    locale: text(body.locale),
    autoLocale: !!body.autoLocale,
    timezone: text(body.timezone),
    autoTimezone: !!body.autoTimezone,
    mailOptIn: !!body.mailOptIn,
  };
}

/** 传 `null` = 清空回「未设定」；省略某个字段 = 不动它。 */
export async function savePreferences(
  authedFetch: AuthedFetch,
  update: MailPreferencesUpdate
): Promise<MailPreferences> {
  const resp = await authedFetch('/api/accounts/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_preferences_save_failed')));
  return normalizePreferences(await parseJson<unknown>(resp));
}

/**
 * 登录时上报浏览器检测值。
 *
 * 服务端**只在「未设定」或「当前是自动档」时才写**（条件写），所以每次登录都能安全调用；
 * 返回里的 `localeWritten` / `timezoneWritten` 告知本次到底写没写 —— 没写说明用户已有手动值。
 */
export async function detectPreferences(
  authedFetch: AuthedFetch,
  detected: { locale?: string | null; timezone?: string | null }
): Promise<MailPreferencesDetectResult> {
  const resp = await authedFetch('/api/accounts/preferences/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(detected),
  });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_preferences_load_failed')));
  const body = (await parseJson<unknown>(resp)) as Record<string, unknown>;
  return {
    ...normalizePreferences(body),
    localeWritten: !!body.localeWritten,
    timezoneWritten: !!body.timezoneWritten,
  };
}

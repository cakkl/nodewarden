import type { Profile } from './types';

/**
 * 用户是否已在账户界面关掉「邮箱未验证」提醒。
 * 按**浏览器**存：它只是界面提示、不影响发信 ⇒ 不值得为它加一列 `users` 字段（那会牵动备份列清单）。
 */
const MUTED_STORAGE_KEY = 'nodewarden.web.email-verification-warning-muted.v1';

export function isEmailVerificationWarningMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setEmailVerificationWarningMuted(muted: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (muted) localStorage.setItem(MUTED_STORAGE_KEY, '1');
    else localStorage.removeItem(MUTED_STORAGE_KEY);
  } catch {
    // 隐私模式等写不进去：忽略，下次登录仍按默认提醒
  }
}

/**
 * 是否提醒用户「邮箱尚未验证」。
 *
 * `profile.emailVerified` 只在「能发信**且**未验证」时为 `false`（不能发信时服务端恒报
 * `true`）⇒ 无需再查 `/api/config`。`warnedProfileId` 用于同一次登录只提醒一次；
 * 用户主动关掉提醒后（`MUTED_STORAGE_KEY`）也不再打扰。
 */
export function shouldWarnUnverifiedEmail(
  profile: Pick<Profile, 'id' | 'emailVerified'> | null | undefined,
  warnedProfileId: string | null
): boolean {
  if (profile?.emailVerified !== false) return false;
  if (isEmailVerificationWarningMuted()) return false;
  const id = String(profile.id || '');
  if (!id) return false;
  return warnedProfileId !== id;
}

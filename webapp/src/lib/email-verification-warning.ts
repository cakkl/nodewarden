import type { Profile } from './types';

/**
 * 是否提醒用户「邮箱尚未验证」。
 *
 * `profile.emailVerified` 只在「能发信**且**未验证」时为 `false`（不能发信时服务端恒报
 * `true`）⇒ 无需再查 `/api/config`。`warnedProfileId` 用于同一次登录只提醒一次。
 */
export function shouldWarnUnverifiedEmail(
  profile: Pick<Profile, 'id' | 'emailVerified'> | null | undefined,
  warnedProfileId: string | null
): boolean {
  if (profile?.emailVerified !== false) return false;
  const id = String(profile.id || '');
  if (!id) return false;
  return warnedProfileId !== id;
}

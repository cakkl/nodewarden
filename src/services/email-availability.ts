// 「能不能给这个用户发信」的统一门禁。
//
// ⭐ 跨功能硬原则：**用户不验证邮箱，就一封邮件都不收。**
// 凡「给某个用户邮箱发信」的功能（邮件 2FA、NDV、主密码提示、通知邮件）都必须先过这里。
// 返回值只说「能不能发」；要区分原因（给用户提示文案）时再看 `reason`。
import { isMailDeliveryAvailableSoft } from './mail-settings';
import type { Env, User } from '../types';

type EmailAvailability =
  | { ok: true }
  | { ok: false; reason: 'email-unverified' | 'mail-unavailable' };

/** 邮箱已验证 **且** 服务端能发信，才允许给该用户发信。 */
export async function emailAvailabilityForUser(env: Env, user: Pick<User, 'emailVerified'>): Promise<EmailAvailability> {
  if (user.emailVerified !== true) {
    return { ok: false, reason: 'email-unverified' };
  }
  if (!(await isMailDeliveryAvailableSoft(env))) {
    return { ok: false, reason: 'mail-unavailable' };
  }
  return { ok: true };
}

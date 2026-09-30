// 默认两步登录提供程序（`users.two_factor_default_provider`）的维护与解析。
//
// 不变量：库里的值**只表达偏好**，绝不决定「能不能登录」—— 该提供程序不可用时一律回退到
// 第一个仍可用项（或 null）；「第一个启用的自动成为默认」由写入路径维护，读路径再兜底一次。
import type { User } from '../types';
import { setDefaultTwoFactorProvider } from './storage-user-repo';
import type { StorageService } from './storage';
import { isYubiKeyEnabled } from '../utils/yubico-otp';
import { isTotpEnabled } from '../utils/totp';

export const TWO_FACTOR_PROVIDER_AUTHENTICATOR = 0;
export const TWO_FACTOR_PROVIDER_EMAIL = 1;
export const TWO_FACTOR_PROVIDER_YUBIKEY = 3;
export const TWO_FACTOR_PROVIDER_WEBAUTHN = 7;

/** 规范顺序（与设置页列表一致）：邮件 → 验证器 App → 通行密钥 → Yubico OTP。 */
export const TWO_FACTOR_PROVIDER_PREFERENCE_ORDER: readonly number[] = [
  TWO_FACTOR_PROVIDER_EMAIL,
  TWO_FACTOR_PROVIDER_AUTHENTICATOR,
  TWO_FACTOR_PROVIDER_WEBAUTHN,
  TWO_FACTOR_PROVIDER_YUBIKEY,
];

/**
 * 该用户**已配置**的提供程序（按规范顺序）。
 *
 * `mailUsable` = 服务端此刻真能发信（`isMailDeliveryAvailable`）。发不出去时邮箱 2FA 整个不计：
 * 它开不了、码发不出来，登录挑战里本来也不列它（`identity.ts`）—— 继续算「已配置」只会让默认值与
 * 设置页指向一个不存在的选项。这只是**读路径**的取舍：库里的开关是偏好，不因邮件故障改写。
 */
export async function listConfiguredTwoFactorProviders(
  storage: StorageService,
  user: User,
  mailUsable = true
): Promise<number[]> {
  const configured = new Set<number>();
  if (user.twoFactorEmailEnabled === true && mailUsable) configured.add(TWO_FACTOR_PROVIDER_EMAIL);
  if (isTotpEnabled(user.totpSecret)) configured.add(TWO_FACTOR_PROVIDER_AUTHENTICATOR);
  if (isYubiKeyEnabled(user)) configured.add(TWO_FACTOR_PROVIDER_YUBIKEY);
  const credentials = await storage.getAccountPasskeyCredentialsByUserId(user.id, 'twoFactor');
  if (credentials.length > 0) configured.add(TWO_FACTOR_PROVIDER_WEBAUTHN);
  return TWO_FACTOR_PROVIDER_PREFERENCE_ORDER.filter((provider) => configured.has(provider));
}

/**
 * 读取时应采用的默认提供程序：存的值仍可用就用它，否则用第一个仍可用的
 *（邮件发不出去时邮箱 2FA 不可用 ⇒ 自动顺位到下一个）。
 */
export async function resolveDefaultTwoFactorProvider(
  storage: StorageService,
  user: User,
  mailUsable = true
): Promise<number | null> {
  const configured = await listConfiguredTwoFactorProviders(storage, user, mailUsable);
  const stored = user.defaultTwoFactorProvider ?? null;
  return stored != null && configured.includes(stored) ? stored : configured[0] ?? null;
}

/**
 * 写入路径的维护：让库里的默认值跟上「用户自己改动了哪些提供程序」，并返回最终值。
 * 幂等 —— 解析结果与已存值相同时不写库。
 *
 * ⚠️ 刻意按「邮件可用」解析（`mailUsable = true`）：库里的值只表达**用户偏好**，不该因为邮件服务
 * 暂时发不出去而漂移（关闭期间读路径自会顺位；恢复后偏好自动生效）。
 */
export async function reconcileDefaultTwoFactorProvider(
  db: D1Database,
  storage: StorageService,
  user: User
): Promise<number | null> {
  const resolved = await resolveDefaultTwoFactorProvider(storage, user, true);
  if (resolved !== (user.defaultTwoFactorProvider ?? null)) {
    await setDefaultTwoFactorProvider(db, user.id, resolved);
    user.defaultTwoFactorProvider = resolved;
  }
  return resolved;
}

/**
 * 登录挑战里把默认提供程序排到首位 —— 客户端（官方客户端与本仓库前端）默认选中列表第一项。
 * 默认项不在列表里时保持原顺序：宁可退回默认顺序，也不能让挑战少一个 provider。
 */
export function orderTwoFactorProvidersForChallenge(providers: string[], preferred: number | null): string[] {
  if (preferred == null) return providers;
  const index = providers.indexOf(String(preferred));
  if (index <= 0) return providers;
  return [providers[index], ...providers.slice(0, index), ...providers.slice(index + 1)];
}

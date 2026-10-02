import type { Env, ProfileResponse, User } from '../types';
import { buildAccountKeys } from './user-decryption';
import { isYubiKeyEnabled } from './yubico-otp';
import { isMailDeliveryAvailableSoft } from '../services/mail-settings';
import { isNewDeviceVerificationEnabled } from '../services/new-device-otp';

export async function buildProfileResponse(
  user: User,
  env?: Env,
  // `mailAvailable` 可由调用方传入（profile 与邮箱验证状态共用同一次查询），
  // 传 Promise 可与其它查询并行；不传则行为与以前完全一致。
  options: { mailAvailable?: boolean | Promise<boolean> } = {}
): Promise<ProfileResponse> {
  const organizations: any[] = [];
  const accountKeys = buildAccountKeys(user);

  // 字段必填，但值要反映「用户能否改变它」：发不出信时用户完不成验证，
  // 报 true 可免掉一个改不掉的横幅（与设置页徽标同一口径；Soft 版查询失败同处理）。
  const mailAvailable = await (options.mailAvailable ?? isMailDeliveryAvailableSoft(env));
  const emailVerified = user.emailVerified === true || !mailAvailable;

  // 新设备验证：报「**有效**」值 —— 未验证邮箱 / 发不出信 / 全局开关关着时，这项保护
  // 根本不会生效，报 true 就是虚假的安全姿态（与该字段的历史注释同一口径）。
  const verifyDevices = user.verifyDevices === true
    && user.emailVerified === true
    && mailAvailable
    && !!env
    && (await isNewDeviceVerificationEnabled(env.DB));

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified,
    premium: true,
    premiumFromOrganization: false,
    usesKeyConnector: false,
    masterPasswordHint: user.masterPasswordHint,
    culture: 'en-US',
    twoFactorEnabled: !!user.totpSecret || isYubiKeyEnabled(user),
    yubikeyEnabled: isYubiKeyEnabled(user),
    key: user.key,
    privateKey: user.privateKey,
    accountKeys,
    securityStamp: user.securityStamp || user.id,
    organizations,
    organizationsNew: organizations,
    providers: [],
    providerOrganizations: [],
    forcePasswordReset: false,
    avatarColor: null,
    creationDate: user.createdAt,
    // New-device verification: report the EFFECTIVE value (see above).
    // Clients must not present a false security posture.
    verifyDevices,
    role: user.role,
    status: user.status,
    object: 'profile',
  };
}

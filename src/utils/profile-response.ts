import type { Env, ProfileResponse, User } from '../types';
import { buildAccountKeys } from './user-decryption';
import { isYubiKeyEnabled } from './yubico-otp';
import { isMailDeliveryAvailableSoft } from '../services/mail-settings';

export async function buildProfileResponse(user: User, env?: Env): Promise<ProfileResponse> {
  const organizations: any[] = [];
  const accountKeys = buildAccountKeys(user);

  // 字段必填，但值要反映「用户能否改变它」：发不出信时用户完不成验证，
  // 报 true 可免掉一个改不掉的横幅（与设置页徽标同一口径；Soft 版查询失败同处理）。
  const mailAvailable = await isMailDeliveryAvailableSoft(env);
  const emailVerified = user.emailVerified === true || !mailAvailable;

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
    // New-device verification is not implemented yet.
    // Always report disabled so clients do not present a false security posture.
    verifyDevices: false,
    role: user.role,
    status: user.status,
    object: 'profile',
  };
}

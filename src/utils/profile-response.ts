import type { Env, ProfileResponse, User } from '../types';
import { buildAccountKeys } from './user-decryption';
import { isYubiKeyEnabled } from './yubico-otp';
import { isMailDeliveryAvailableSoft } from '../services/mail-settings';

export async function buildProfileResponse(user: User, env?: Env): Promise<ProfileResponse> {
  const organizations: any[] = [];
  const accountKeys = buildAccountKeys(user);

  // `emailVerified` 必须保留（客户端标为非空必填），但值要反映「用户能否改变它」：
  // 服务端无法发信时用户**根本完不成**验证 ⇒ 报 true，避免客户端展示一个改不掉的
  // 「未验证」横幅。这与设置页「仅当服务端能发信时才显示验证徽标」的处理一致
  // （见 docs/TODO/COMPAT.md 待处理项 2）。
  // `env` 缺省时无法判断 ⇒ 同样报 true（保守：不打扰用户）。
  // 用 Soft 版：查询失败也不报错，只当「不能发信」处理。
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

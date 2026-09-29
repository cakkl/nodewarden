// 两步登录提供程序的编号与展示顺序（跨组件共用，避免各处各写一套数字）。
import { t } from './i18n';

/** 与 Identity 的 `TwoFactorProviderType` 一致。 */
export const TWO_FACTOR_PROVIDER_AUTHENTICATOR = 0;
export const TWO_FACTOR_PROVIDER_EMAIL = 1;
export const TWO_FACTOR_PROVIDER_YUBIKEY = 3;
export const TWO_FACTOR_PROVIDER_WEBAUTHN = 7;

/**
 * 恢复码（官方枚举里是 8）**不在服务端返回的名单里**（部分客户端解析到未知 provider 会报错），
 * 所以这里只用它做**弹窗内的选择标记**：不会发给服务端，也不写进 `pendingTotp.providerType`。
 */
export const TWO_FACTOR_PROVIDER_RECOVERY_CODE = 8;

/** 「其他验证方式」的展示顺序：通行密钥 → YubiKey → 邮件 → 验证器 App。 */
export const TWO_FACTOR_PROVIDER_ORDER = [
  TWO_FACTOR_PROVIDER_WEBAUTHN,
  TWO_FACTOR_PROVIDER_YUBIKEY,
  TWO_FACTOR_PROVIDER_EMAIL,
  TWO_FACTOR_PROVIDER_AUTHENTICATOR,
] as const;

/** 登录弹窗里的输入框标题 / 切换列表里的选项名。 */
export function twoFactorProviderLabel(providerType: number): string {
  if (providerType === TWO_FACTOR_PROVIDER_WEBAUTHN) return t('txt_passkey');
  if (providerType === TWO_FACTOR_PROVIDER_YUBIKEY) return t('txt_otp_from_yubikey');
  if (providerType === TWO_FACTOR_PROVIDER_EMAIL) return t('txt_email_verification_code');
  if (providerType === TWO_FACTOR_PROVIDER_RECOVERY_CODE) return t('txt_recovery_code');
  return t('txt_authenticator_app');
}

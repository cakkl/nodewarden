// 「用恢复码停用两步登录」的**唯一**实现：登录请求里的提供程序 8（官方客户端走这条）与
// `POST /identity/accounts/recover-2fa` 都调它。
//
// ⚠️ 这两条入口曾各写一份，于是漂移出 bug：后者漏停邮件 2FA ⇒ 下次登录又卡在邮件码，
// 而邮件恰恰最容易收不到，直接变成死循环。收尾动作只加在这里。
import type { Env, User } from '../types';
import { createRecoveryCode } from '../utils/recovery-code';
import { generateUUID } from '../utils/uuid';
import { AuthService } from './auth';
import { clearChallengeCode } from './email-2fa';
import type { StorageService } from './storage';
import { saveUserPreferences } from './storage-user-repo';
import { reconcileDefaultTwoFactorProvider } from './two-factor-default';

/**
 * 停用该用户的**全部**两步登录（验证器 / YubiKey / 通行密钥 / 邮件）、轮换恢复码与安全戳，
 * 并让既有会话失效。返回新的恢复码 —— 校验恢复码与写审计由调用方负责。
 */
export async function resetTwoFactorByRecoveryCode(
  env: Env,
  storage: StorageService,
  user: User
): Promise<string> {
  user.totpSecret = null;
  user.yubikeyKey1 = null;
  user.yubikeyKey2 = null;
  user.yubikeyKey3 = null;
  user.yubikeyKey4 = null;
  user.yubikeyKey5 = null;
  user.yubikeyNfc = false;
  for (const credential of await storage.getAccountPasskeyCredentialsByUserId(user.id, 'twoFactor')) {
    await storage.deleteAccountPasskeyCredential(user.id, credential.id, 'twoFactor');
  }
  // 邮件 2FA 也是「两步登录」的一员：漏停它，用户就会陷入「收不到邮件 → 用恢复码 →
  // 下次登录又要邮件码」的死循环。内存里也得改 —— 下面的 reconcile 按内存字段算。
  user.twoFactorEmailEnabled = false;
  user.totpRecoveryCode = createRecoveryCode();
  user.securityStamp = generateUUID();
  user.updatedAt = new Date().toISOString();
  await storage.saveUser(user);
  // 这两项走专用写入（`saveUser` 是定列覆盖，不含它们，与 mail_opt_in 同理）。
  await saveUserPreferences(env.DB, user.id, { twoFactorEmailEnabled: false });
  await clearChallengeCode(env.DB, user.id);
  // 提供程序全空 ⇒ 默认值也归零（留着就是一个永远不生效的偏好）。
  await reconcileDefaultTwoFactorProvider(env.DB, storage, user);
  // 会话失效：安全戳能让访问令牌作废，刷新令牌再显式删掉，不留换新令牌的口子。
  await storage.deleteRefreshTokensByUserId(user.id);
  AuthService.invalidateUserCache(user.id);
  return user.totpRecoveryCode;
}

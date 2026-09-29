// 新设备验证（NDV）：陌生设备登录的拦截判定（判定链见 `resolveNewDeviceVerification`）。
//
// ⚠️ 两个字符串**逐字**对客户端有意义，大小写与句点都不能改：
//   `ErrorModel.Message` = `new device verification required`（客户端据此进输码页）
//   `error_description` = `Invalid New Device OTP`（客户端据此显示本地化的「验证码无效」）
import { safeWriteAuditEvent } from '../services/audit-events';
import { emailAvailabilityForUser } from '../services/email-availability';
import { resolveMailConnection, resolveMailRenderPreferences } from '../services/mail-settings';
import { sendSmtpMail } from '../services/smtp-client';
import { renderNewDeviceVerificationEmail } from '../services/mail';
import {
  checkNewDeviceOtpQuota,
  isNewDeviceVerificationEnabled,
  issueNewDeviceOtp,
  verifyNewDeviceOtp,
} from '../services/new-device-otp';
import { AuthService } from '../services/auth';
import { StorageService } from '../services/storage';
import type { Env, User } from '../types';
import { errorResponse, jsonResponse } from '../utils/response';
import { constantTimeEquals } from '../utils/api-key';

/** 新账号豁免期：与官方一致，创建 24h 内不拦。 */
const NEW_DEVICE_VERIFICATION_ACCOUNT_GRACE_MS = 24 * 60 * 60 * 1000;

interface NewDeviceVerificationInput {
  user: User;
  /** 请求里的设备标识；缺失时传空串（当作陌生设备，不放过） */
  deviceIdentifier: string;
  /** 该用户是否启用了任一 2FA provider —— 有 2FA 就不走 NDV（官方同款） */
  twoFactorEnabled: boolean;
  /** 本次请求带的验证码（`NewDeviceOtp`），无则 null */
  newDeviceOtp: string | null;
  /** 「使用设备登录」（auth request）流程：已有设备确认即可，不叠加邮件码 */
  skipForAuthRequest: boolean;
}

/** 400 `new device verification required`（客户端据此跳转输码页） */
function newDeviceVerificationRequiredResponse(): Response {
  return jsonResponse(
    {
      error: 'device_error',
      error_description: 'New device verification required',
      ErrorModel: { Message: 'new device verification required', Object: 'error' },
    },
    400,
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
  );
}

/** 400 `invalid new device otp`（客户端据此显示「验证码无效」） */
function invalidNewDeviceOtpResponse(): Response {
  return jsonResponse(
    {
      error: 'device_error',
      error_description: 'Invalid New Device OTP',
      ErrorModel: { Message: 'invalid new device otp', Object: 'error' },
    },
    400,
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
  );
}

/**
 * 发新设备验证码。失败**只写审计**，不影响响应 —— 响应必须与「已发码」一致，
 * 否则「信发出去了没有」就成了判据。
 */
async function deliverNewDeviceOtpMail(
  env: Env,
  user: User,
  code: string,
  expiresAt: string
): Promise<void> {
  const connection = await resolveMailConnection(env.DB, env);
  if (connection.status !== 'ok') return;

  const preferences = resolveMailRenderPreferences(user);
  const mail = renderNewDeviceVerificationEmail(
    { code, expiresAt: new Date(expiresAt) },
    { locale: preferences.locale, timezone: preferences.timezone }
  );

  try {
    await sendSmtpMail(connection.settings, {
      to: user.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch {
    await safeWriteAuditEvent(env, {
      actorUserId: user.id,
      action: 'auth.login.new_device.mail_failed',
      category: 'auth',
      level: 'warn',
      targetType: 'user',
      targetId: user.id,
    });
  }
}

/**
 * 判定本次密码登录能否直接放行。
 *
 * @returns `{ allow: true }` 或 `{ allow: false, response }`（调用方**原样**返回该响应）
 */export async function resolveNewDeviceVerification(
  env: Env,
  storage: StorageService,
  input: NewDeviceVerificationInput
): Promise<{ allow: true } | { allow: false; response: Response }> {
  const { user, deviceIdentifier } = input;

  // 使用设备登录（auth request）：由已有设备确认，本身就是第二因素 ⇒ 不叠加邮件码。
  if (input.skipForAuthRequest) return { allow: true };
  // 有 2FA 的用户走 2FA 挑战（官方只在 TwoFactorRequired == false 时进 NDV）。
  if (input.twoFactorEnabled) return { allow: true };
  if (!(await isNewDeviceVerificationEnabled(env.DB))) return { allow: true };

  // 已知设备 ⇒ 放行（设备行在「登录成功」时才写，所以这里判定的是「之前成功登录过」）
  if (deviceIdentifier && (await storage.getDevice(user.id, deviceIdentifier))) return { allow: true };

  // ⭐ 我们的前置门禁：给不了这个用户发信（邮箱未验证 / 服务器发不出信）⇒ 直接放行、零发信。
  // 否则会把「不想验证邮箱」的用户永久锁在门外。
  if (!(await emailAvailabilityForUser(env, user)).ok) return { allow: true };

  // 用户自己关了（默认是开的，见 users.verify_devices 的默认值）
  if (user.verifyDevices !== true) return { allow: true };

  // 新账号豁免：与官方一致，避免刚注册就被拦
  if (Date.now() - new Date(user.createdAt).getTime() < NEW_DEVICE_VERIFICATION_ACCOUNT_GRACE_MS) {
    return { allow: true };
  }

  if (input.newDeviceOtp) {
    const outcome = await verifyNewDeviceOtp(env.DB, user.id, deviceIdentifier, input.newDeviceOtp, env.JWT_SECRET);
    if (outcome === 'ok') {
      await safeWriteAuditEvent(env, {
        actorUserId: user.id,
        action: 'auth.login.new_device.verified',
        category: 'auth',
        level: 'info',
        targetType: 'user',
        targetId: user.id,
        metadata: { deviceIdentifier },
      });
      return { allow: true };
    }
    // 错误码与官方一致，客户端据此显示「验证码无效」而不是「需要验证」
    return { allow: false, response: invalidNewDeviceOtpResponse() };
  }

  // 该用户还没有任何设备（首次登录）⇒ 放行，与官方一致
  if ((await storage.getDevicesByUserId(user.id)).length === 0) return { allow: true };

  const quota = await checkNewDeviceOtpQuota(env.DB, user.id, deviceIdentifier);
  const challenge = newDeviceVerificationRequiredResponse();
  await safeWriteAuditEvent(env, {
    actorUserId: user.id,
    action: 'auth.login.new_device.challenged',
    category: 'auth',
    level: 'warn',
    targetType: 'user',
    targetId: user.id,
    metadata: { deviceIdentifier, mailSent: quota.allowed },
  });
  if (!quota.allowed) return { allow: false, response: challenge };

  const issued = await issueNewDeviceOtp(env.DB, user.id, deviceIdentifier, env.JWT_SECRET);
  await deliverNewDeviceOtpMail(env, user, issued.code, issued.expiresAt);
  return { allow: false, response: challenge };
}

/**
 * `POST /accounts/resend-new-device-otp`（输码页的「重新发送」）。
 *
 * 官方契约：`[AllowAnonymous]`，body `{ email, masterPasswordHash }`，设备标识走 `Device-Identifier` 头。
 * ⚠️ **无需登录** ⇒ 响应必须与「发了」逐字一致（邮箱不存在 / 密码错 / 未验证 / 被限流都相同），
 * 否则它就成了账号与设备状态的探针。
 */
export async function handleResendNewDeviceOtp(request: Request, env: Env): Promise<Response> {
  const ok = () => jsonResponse({ object: 'resend-new-device-otp' });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const email = String(body.email ?? body.Email ?? '').trim().toLowerCase();
  const passwordHash = String(body.masterPasswordHash ?? body.MasterPasswordHash ?? '').trim();
  const deviceIdentifier = String(request.headers.get('Device-Identifier') ?? body.deviceIdentifier ?? '').trim();
  if (!email || !passwordHash) return errorResponse('Email and master password hash are required', 400);

  const storage = new StorageService(env.DB);
  const user = await storage.getUser(email);
  // 账号不存在 / 密码不对 / 不需要验证 / 未验证邮箱 / 被限流 ⇒ 一律返回同一响应，不发信。
  if (!user || user.status !== 'active') return ok();
  const auth = new AuthService(env);
  const storedHash = String(user.masterPasswordHash || '').trim();
  if (!storedHash) return ok();
  const serverHash = await auth.hashPasswordServer(passwordHash, user.email);
  if (!constantTimeEquals(serverHash, storedHash)) return ok();
  if (user.verifyDevices !== true) return ok();
  if (!(await emailAvailabilityForUser(env, user)).ok) return ok();
  if (!(await isNewDeviceVerificationEnabled(env.DB))) return ok();

  const quota = await checkNewDeviceOtpQuota(env.DB, user.id, deviceIdentifier);
  if (!quota.allowed) return ok();

  const issued = await issueNewDeviceOtp(env.DB, user.id, deviceIdentifier, env.JWT_SECRET);
  await deliverNewDeviceOtpMail(env, user, issued.code, issued.expiresAt);
  // 刻意不写审计：重发是用户主动动作，且频次由限流管住；日志中心不需要被它刷屏。
  return ok();
}

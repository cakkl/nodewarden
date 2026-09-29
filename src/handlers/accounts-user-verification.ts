// User Verification 的邮箱码 —— `POST /accounts/request-otp` + `POST /accounts/verify-otp`。
//
// 官方只给**无主密码账号**展示这条路径（`otp: !userHasMasterPassword`），本项目所有账号都有主密码
// ⇒ 客户端不会走到这里；实现它是补齐契约。**不做**「无主密码」前置限制：能收到信就证明邮箱归属。
//
// ⚠️ 字段名大小写**不对称**（从官方桌面 bundle 反查）：`verify-otp` 的 body 是 `{ OTP }`（大写），
// 敏感端点的 body 用小写 `otp` ⇒ 这里两种都读。
import { auditRequestMetadata, writeAuditEvent } from '../services/audit-events';
import { emailAvailabilityForUser } from '../services/email-availability';
import {
  checkSendQuota,
  clearChallengeCode,
  issueChallengeCode,
  verifyChallengeCode,
} from '../services/email-2fa';
import { renderUserVerificationEmail } from '../services/mail';
import { resolveMailConnection, resolveMailRenderPreferences } from '../services/mail-settings';
import { sendSmtpMail } from '../services/smtp-client';
import { StorageService } from '../services/storage';
import type { Env } from '../types';
import { errorResponse, jsonResponse } from '../utils/response';

/** 空 body 当 `{}`（客户端不一定发 body）⇒ 后续按「缺码」报 400，而不是 JSON 解析错。 */
async function readOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = body[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** 发码。客户端不看响应体（`send(..., hasResponse=false)`），但失败状态码会被当成错误。 */
export async function handleRequestAccountOtp(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const user = await storage.getUserById(userId);
  if (!user) return errorResponse('User not found', 404);

  // 与其它发信功能同一道门禁：发不出去就明确报错，不假装发过（本端点是已认证的，无枚举顾虑）。
  const availability = await emailAvailabilityForUser(env, user);
  if (!availability.ok) {
    return errorResponse(
      availability.reason === 'email-unverified'
        ? 'Verify your email address before requesting a verification code'
        : 'Email delivery is not configured on this server',
      availability.reason === 'email-unverified' ? 400 : 503
    );
  }

  const quota = await checkSendQuota(env.DB, user.id);
  if (!quota.allowed) {
    if (quota.reason === 'too-soon') return errorResponse('Please wait before requesting another code', 429);
    if (quota.reason === 'hourly-limit') return errorResponse('Too many codes were requested this hour', 429);
    return errorResponse('The daily code limit has been reached', 429);
  }

  const connection = await resolveMailConnection(env.DB, env);
  if (connection.status !== 'ok') {
    return errorResponse('Email delivery is not configured on this server', 503);
  }

  const issued = await issueChallengeCode(env.DB, user.id, env.JWT_SECRET);
  const mail = renderUserVerificationEmail(
    { code: issued.code, expiresAt: new Date(issued.expiresAt) },
    resolveMailRenderPreferences(user)
  );
  try {
    await sendSmtpMail(connection.settings, {
      to: user.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    // 发信失败就作废刚写的码（用户拿不到码，库里不该留一枚有效码）
    await clearChallengeCode(env.DB, user.id);
    await writeAuditEvent(storage, {
      actorUserId: user.id,
      action: 'account.user_verification.otp_send_failed',
      category: 'auth',
      level: 'warn',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: error instanceof Error ? error.message : String(error), ...auditRequestMetadata(request) },
    });
    return errorResponse('Unable to send the verification code. Please try again.', 503);
  }

  return jsonResponse({ object: 'accountOtp', sent: true, expiresAt: issued.expiresAt });
}

/** 验码。成功即消费（一次性）；失败一律同一文案 —— 客户端只据此显示「验证码无效」。 */
export async function handleVerifyAccountOtp(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const user = await storage.getUserById(userId);
  if (!user) return errorResponse('User not found', 404);

  let body: Record<string, unknown>;
  try {
    body = await readOptionalJsonBody(request);
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const code = readString(body, ['OTP', 'otp', 'Otp']).trim();
  if (!code) return errorResponse('Verification code is required', 400);

  const outcome = await verifyChallengeCode(env.DB, user.id, code, env.JWT_SECRET);
  if (outcome !== 'ok') return errorResponse('Invalid verification code', 400);

  await writeAuditEvent(storage, {
    actorUserId: user.id,
    action: 'account.user_verification.otp_verified',
    category: 'auth',
    level: 'info',
    targetType: 'user',
    targetId: user.id,
    metadata: { ...auditRequestMetadata(request) },
  });
  return jsonResponse({ object: 'accountOtp', verified: true });
}

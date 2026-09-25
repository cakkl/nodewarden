/**
 * 邮箱验证：已登录用户确认「这个邮箱确实是我的」。
 *
 * GET  /api/accounts/email-verification  可用性与当前状态
 * POST /api/accounts/email-token         发送验证码
 * POST /api/accounts/verify-email        提交验证码
 *
 * 只处理**当前账户自己的**邮箱。请求体里若带了一个不同的邮箱，直接拒绝而不是静默忽略：
 * 本服务器不支持改邮箱，忽略会让调用方以为改成功了。
 *
 * 验证成功后 `users.email_verified` 置 1，之后才允许接收安全通知邮件。
 * 未验证不阻断登录/同步，只在界面上提示。
 */
import type { Env, User } from '../types';
import { jsonResponse, errorResponse } from '../utils/response';
import { StorageService } from '../services/storage';
import { auditRequestMetadata, writeAuditEvent } from '../services/audit-events';
import { getMailSettings, resolveMailConnection, isMailDeliveryAvailable, resolveMailRenderPreferences } from '../services/mail-settings';
import { sendSmtpMail, SmtpDeliveryError } from '../services/smtp-client';
import { renderVerificationEmail } from '../services/mail';
import { setEmailVerified } from '../services/storage-user-repo';
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  checkSendQuota,
  clearVerificationCode,
  issueVerificationCode,
  verifyEmailCode,
} from '../services/email-verification';
import { smtpFailureResponse } from './admin-mail';

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeEmailVerificationAudit(
  env: Env,
  actorUser: User,
  action: string,
  metadata: Record<string, unknown>,
  request: Request
): Promise<void> {
  await writeAuditEvent(new StorageService(env.DB), {
    actorUserId: actorUser.id,
    action,
    targetType: 'user',
    targetId: actorUser.id,
    category: 'security',
    level: 'security',
    metadata: { ...metadata, ...auditRequestMetadata(request) },
  });
}

/** 读出「已发出且仍有效」的验证码到期时间；没有则是 null。 */
async function readPendingExpiry(db: D1Database, user: User): Promise<string | null> {
  const row = await db
    .prepare('SELECT email, expires_at FROM email_verification_tokens WHERE user_id = ?')
    .bind(user.id)
    .first<{ email: string; expires_at: string }>();
  if (!row) return null;
  // 邮箱变过 ⇒ 这枚码已经作废，对外当作没有
  if (row.email !== String(user.email || '').toLowerCase()) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.expires_at;
}

// GET /api/accounts/email-verification
export async function handleGetEmailVerificationStatus(
  request: Request,
  env: Env,
  currentUser: User
): Promise<Response> {
  void request;
  const [available, pendingExpiresAt] = await Promise.all([
    isMailDeliveryAvailable(env.DB, env),
    readPendingExpiry(env.DB, currentUser),
  ]);
  return jsonResponse(
    {
      object: 'emailVerification',
      available,
      verified: currentUser.emailVerified === true,
      email: currentUser.email,
      pendingExpiresAt,
      codeTtlSeconds: Math.floor(CODE_TTL_MS / 1000),
      maxAttempts: MAX_CODE_ATTEMPTS,
    },
    200,
    // 验证状态是随时会变的事实，任何缓存都可能让客户端停在旧值上。
    { 'Cache-Control': 'no-store' }
  );
}

// POST /api/accounts/email-token
export async function handleSendEmailVerificationCode(
  request: Request,
  env: Env,
  currentUser: User
): Promise<Response> {
  const email = String(currentUser.email || '').trim();
  if (!email) return errorResponse('This account has no email address', 400);
  if (currentUser.emailVerified === true) {
    return errorResponse('This email address is already verified', 409);
  }

  const body = await readJsonBody(request);
  const requestedEmail = String(body.email ?? '').trim();
  if (requestedEmail && requestedEmail.toLowerCase() !== email.toLowerCase()) {
    return errorResponse('This server does not support changing the account email address', 409);
  }

  // 一次读配置同时拿到「是否开启」与连接参数，避免 resolveMailConnection 再查一遍
  const mailSettings = await getMailSettings(env.DB);
  if (!mailSettings.enabled) {
    return errorResponse('Email delivery is not configured on this server', 503);
  }

  const quota = await checkSendQuota(env.DB, currentUser.id);
  if (!quota.allowed) {
    if (quota.reason === 'too-soon') {
      return errorResponse('Please wait before requesting another verification code', 429);
    }
    if (quota.reason === 'hourly-limit') {
      return errorResponse('Too many verification emails were requested this hour', 429);
    }
    return errorResponse('The daily verification email limit has been reached', 429);
  }

  // 复用上面那份配置；失败即主机 / 发件人没配全，或口令解不开
  const connection = await resolveMailConnection(env.DB, env, mailSettings);
  if (connection.status !== 'ok') {
    return errorResponse('Email delivery is not configured on this server', 503);
  }

  // 先落库再发信：如果发信失败，用户手上那枚旧码已经被新的顶掉了。
  // 这是「安全方向」的失败 —— 宁可让人重发一次，也不要留下两枚同时有效的码。
  const issued = await issueVerificationCode(env.DB, currentUser.id, email, env.JWT_SECRET);
  // 语言/时区取自**收件人自己**的偏好（未设定则回退英文/UTC，并由模板追加提示句）
  const mail = renderVerificationEmail(
    { code: issued.code, expiresAt: new Date(issued.expiresAt) },
    resolveMailRenderPreferences(currentUser)
  );

  try {
    await sendSmtpMail(connection.settings, {
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (error) {
    // 发不出去就把码清掉，别让一枚「已经发到别处去」的码留在库里等着被猜
    await clearVerificationCode(env.DB, currentUser.id).catch(() => undefined);
    if (error instanceof SmtpDeliveryError) return smtpFailureResponse(error);
    throw error;
  }

  await writeEmailVerificationAudit(env, currentUser, 'account.email.verification.send', { email }, request);
  return jsonResponse({
    object: 'emailVerification',
    sent: true,
    email,
    expiresAt: issued.expiresAt,
    codeTtlSeconds: Math.floor(CODE_TTL_MS / 1000),
  });
}

// POST /api/accounts/verify-email
export async function handleVerifyEmailCode(
  request: Request,
  env: Env,
  currentUser: User
): Promise<Response> {
  const email = String(currentUser.email || '').trim();
  if (!email) return errorResponse('This account has no email address', 400);
  if (currentUser.emailVerified === true) {
    return jsonResponse({ object: 'emailVerification', verified: true, email });
  }

  const body = await readJsonBody(request);
  // 客户端在不同流程里把同一枚码叫成不同名字，都收
  const raw = body.code ?? body.token ?? body.emailVerificationToken ?? body.verificationToken;
  const code = String(raw ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return errorResponse('A 6-digit verification code is required', 400);
  }

  const outcome = await verifyEmailCode(
    env.DB,
    { id: currentUser.id, email },
    code,
    env.JWT_SECRET
  );
  if (outcome !== 'ok') {
    const message =
      outcome === 'no-code'
        ? 'No verification code is pending for this address. Request a new one.'
        : outcome === 'expired'
          ? 'This verification code has expired. Request a new one.'
          : outcome === 'too-many-attempts'
            ? 'Too many incorrect attempts. Request a new code.'
            : 'The verification code is incorrect';
    return jsonResponse(
      { error: 'invalid_verification_code', error_description: message, reason: outcome, Object: 'error' },
      400
    );
  }

  await setEmailVerified(env.DB, currentUser.id, true);
  await writeEmailVerificationAudit(env, currentUser, 'account.email.verification.confirm', { email }, request);
  return jsonResponse({ object: 'emailVerification', verified: true, email });
}

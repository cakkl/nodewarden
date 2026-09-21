/**
 * 管理端「邮件发送（SMTP）」配置与自检端点。
 *
 * GET/PUT `/api/admin/mail/settings`，POST `/api/admin/mail/settings/test`。
 * 测试端点真的发一封信 —— SMTP 的行为差异几乎全在握手细节里，只探「能连上」会给出虚假的安全感。
 * 收件人固定为操作者自己的邮箱，不接受请求体传入地址（否则就是开放中继）。
 */
import type { Env, User } from '../types';
import { jsonResponse, errorResponse } from '../utils/response';
import { StorageService } from '../services/storage';
import { auditRequestMetadata, writeAuditEvent } from '../services/audit-events';
import { claimConfigValue } from '../services/storage-config-repo';
import { requireMasterPasswordHash } from './admin';
import {
  MAIL_TEST_THROTTLE_CONFIG_KEY,
  MailSettingsValidationError,
  getMailSettings,
  inferEncryption,
  normalizeMailSettingsInput,
  readStoredMailPassword,
  saveMailSettings,
} from '../services/mail-settings';
import { SmtpDeliveryError, sendSmtpMail } from '../services/smtp-client';
import { renderTestEmail } from '../services/mail';

function isAdmin(user: User): boolean {
  return user.role === 'admin' && user.status === 'active';
}

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

async function writeAdminMailAudit(
  env: Env,
  actorUser: User,
  action: string,
  metadata: Record<string, unknown>,
  request?: Request
): Promise<void> {
  const storage = new StorageService(env.DB);
  await writeAuditEvent(storage, {
    actorUserId: actorUser.id,
    action,
    targetType: 'mailSettings',
    targetId: null,
    category: 'security',
    level: 'security',
    metadata: {
      ...metadata,
      ...(request ? auditRequestMetadata(request) : {}),
    },
  });
}

/**
 * 把 SMTP 失败翻成 HTTP 响应。回结构化字段（`smtpStage` / `smtpCode` / `timedOut`）
 * 供前端映射文案 —— 服务器回复里的 5xx 详情是动态的，`translateServerError` 匹配不上。
 * 用 502：语义上是上游 SMTP 拒绝/不可用。
 */
function smtpFailureResponse(error: SmtpDeliveryError): Response {
  return jsonResponse(
    {
      error: 'mail_delivery_failed',
      error_description: error.message,
      smtpStage: error.stage,
      smtpCode: error.code,
      timedOut: error.timedOut,
      ErrorModel: { Message: error.message, Object: 'error' },
      Object: 'error',
    },
    502
  );
}

// GET /api/admin/mail/settings
export async function handleAdminGetMailSettings(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  void request;
  if (!isAdmin(actorUser)) return errorResponse('Forbidden', 403);
  return jsonResponse({ object: 'mailSettings', ...(await getMailSettings(env.DB)) });
}

// PUT /api/admin/mail/settings
export async function handleAdminUpdateMailSettings(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) return errorResponse('Forbidden', 403);

  const body = await readJsonBody(request);
  const passwordError = await requireMasterPasswordHash(env, actorUser, body.masterPasswordHash);
  if (passwordError) return passwordError;

  try {
    const input = normalizeMailSettingsInput(body);
    const settings = await saveMailSettings(env.DB, env, input);
    // 审计只记非敏感摘要
    await writeAdminMailAudit(
      env,
      actorUser,
      'admin.mail.settings.update',
      {
        enabled: settings.enabled,
        host: settings.host,
        port: settings.port,
        encryption: settings.encryption,
        fromAddress: settings.fromAddress,
        passwordChanged: !!input.password,
        passwordCleared: !settings.passwordConfigured,
      },
      request
    );
    return jsonResponse({ object: 'mailSettings', ...settings });
  } catch (error) {
    if (error instanceof MailSettingsValidationError) return errorResponse(error.message, 400);
    throw error;
  }
}

/** 同一个 10 秒窗口内只允许发一次测试邮件，避免被脚本刷额度。 */
async function claimMailTestSlot(db: D1Database): Promise<boolean> {
  const bucket = String(Math.floor(Date.now() / 10_000));
  return claimConfigValue(db, MAIL_TEST_THROTTLE_CONFIG_KEY, bucket);
}

/**
 * 发送测试邮件。配置取自**请求体**而非已保存的值 —— 界面要求「先测试通过才能保存」，
 * 所以测试必须能针对尚未落库的表单值。口令留空时沿用已保存的那份。
 *
 * 不要求主密码（只有保存才需要）：测试只会给操作者**自己**的邮箱发一封信，
 * 且已经登录的管理员本就具备修改该配置的权限；靠节流窗口防刷即可。
 */
// POST /api/admin/mail/settings/test
export async function handleAdminSendTestMail(
  request: Request,
  env: Env,
  actorUser: User
): Promise<Response> {
  if (!isAdmin(actorUser)) return errorResponse('Forbidden', 403);

  if (!(await claimMailTestSlot(env.DB))) {
    return errorResponse('Sending test emails is limited to once every 10 seconds', 429);
  }

  const body = await readJsonBody(request);

  let input;
  try {
    input = normalizeMailSettingsInput(body);
  } catch (error) {
    if (error instanceof MailSettingsValidationError) return errorResponse(error.message, 400);
    throw error;
  }
  if (!input.host || !input.fromAddress) {
    return errorResponse('An SMTP host and sender address are required before testing', 400);
  }

  let password = input.password ?? '';
  if (!password && input.username) {
    password = (await readStoredMailPassword(env.DB, env)) ?? '';
    if (!password) {
      return errorResponse('An SMTP password is required for this username. Enter it to test.', 409);
    }
  }

  const recipient = String(actorUser.email || '').trim();
  if (!recipient) return errorResponse('The acting administrator has no email address', 400);

  const connection = {
    host: input.host,
    port: input.port,
    encryption: inferEncryption(input.port),
    username: input.username,
    password,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
  };

  try {
    const mail = renderTestEmail(
      {
        host: connection.host,
        port: connection.port,
        encryption: connection.encryption,
        sentAt: new Date(),
      },
      { locale: input.locale, timezone: input.timezone }
    );
    const result = await sendSmtpMail(connection, { to: recipient, ...mail });
    await writeAdminMailAudit(
      env,
      actorUser,
      'admin.mail.test',
      {
        host: connection.host,
        port: connection.port,
        encryption: connection.encryption,
        authMethod: result.authMethod,
        response: result.response.slice(0, 200),
      },
      request
    );
    return jsonResponse({
      object: 'mailTestResult',
      ok: true,
      recipient,
      authMethod: result.authMethod,
      encryption: result.encryption,
      response: result.response,
    });
  } catch (error) {
    if (error instanceof SmtpDeliveryError) {
      // 只记环节与状态码，绝不记凭据或 AUTH 载荷
      console.warn('Mail test failed', {
        host: connection.host,
        port: connection.port,
        stage: error.stage,
        code: error.code,
        timedOut: error.timedOut,
        message: error.message,
      });
      await writeAdminMailAudit(
        env,
        actorUser,
        'admin.mail.test.failed',
        {
          host: connection.host,
          port: connection.port,
          encryption: connection.encryption,
          stage: error.stage,
          code: error.code,
          timedOut: error.timedOut,
        },
        request
      );
      return smtpFailureResponse(error);
    }
    throw error;
  }
}

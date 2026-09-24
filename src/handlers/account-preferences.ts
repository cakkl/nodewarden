/**
 * 用户级「语言 / 时区」偏好。
 *
 *   GET  /api/accounts/preferences          读自己的偏好
 *   PUT  /api/accounts/preferences          自己选定
 *   POST /api/accounts/preferences/detect   上报浏览器检测值（条件写）
 *
 * 只要求登录，**不做管理员检查**：普通用户必须能自己设，且不随管理员变动。
 * 语言与「界面语言」是同一个值（前端登录后据此 `setLocale()`）。
 * 不写审计：个人显示偏好不是安全事件，写进去只会淹没日志中心里真正的安全条目。
 */
import type { Env, User } from '../types';
import { jsonResponse, errorResponse } from '../utils/response';
import { isValidTimeZone } from '../utils/timezone';
import { AuthService } from '../services/auth';
import { matchMailLocale } from '../services/mail';
import { StorageService } from '../services/storage';
import { detectUserPreferences, saveUserPreferences } from '../services/storage-user-repo';

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 对外形状：值 + 来源标记（`auto*` = 该值是自动检测来的，可被登录时刷新）。 */
function preferencesResponse(user: User): Record<string, unknown> {
  return {
    object: 'preferences',
    locale: user.locale ?? null,
    autoLocale: !!user.autoLocale,
    timezone: user.timezone ?? null,
    autoTimezone: !!user.autoTimezone,
    mailOptIn: !!user.mailOptIn,
  };
}

/** 写完之后回读一次，把库里的最终状态回给前端（PUT 允许只传部分字段）。 */
async function respondWithFreshPreferences(env: Env, userId: string): Promise<Response> {
  const user = await new StorageService(env.DB).getUserById(userId);
  if (!user) return errorResponse('User not found', 404);
  return jsonResponse(preferencesResponse(user));
}

// GET /api/accounts/preferences
export async function handleGetPreferences(
  request: Request,
  env: Env,
  currentUser: User
): Promise<Response> {
  void request;
  return respondWithFreshPreferences(env, currentUser.id);
}

// PUT /api/accounts/preferences
//
// 严格校验：这是用户输入，非法值应当明确报错（400）而不是静默忽略。
// 传 `null` 或空串 = 清空回「未设定」；省略某个字段 = 不动它。
export async function handleUpdatePreferences(
  request: Request,
  env: Env,
  currentUser: User
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return errorResponse('Invalid JSON', 400);

  const update: {
    locale?: string | null;
    localeAuto?: boolean;
    timezone?: string | null;
    timezoneAuto?: boolean;
    mailOptIn?: boolean;
  } = {};

  if ('locale' in body) {
    const raw = body.locale;
    if (raw === null || raw === '') {
      update.locale = null;
    } else {
      const matched = matchMailLocale(raw);
      if (!matched) return errorResponse('Unknown locale', 400);
      update.locale = matched;
    }
  }

  if ('timezone' in body) {
    const raw = body.timezone;
    if (raw === null || raw === '') {
      update.timezone = null;
    } else if (isValidTimeZone(raw)) {
      update.timezone = raw.trim();
    } else {
      return errorResponse('Unknown time zone', 400);
    }
  }

  // 显式的「自动档」标志：界面上选「自动（按浏览器）」时会同时传值 + `*Auto: true`。
  // errorResponse 的消息必须是字面量（error-message-guard 拦截模板串，防动态内容原样回给客户端）。
  if ('localeAuto' in body) {
    if (typeof body.localeAuto !== 'boolean') return errorResponse('localeAuto must be a boolean', 400);
    update.localeAuto = body.localeAuto;
  }
  if ('timezoneAuto' in body) {
    if (typeof body.timezoneAuto !== 'boolean') return errorResponse('timezoneAuto must be a boolean', 400);
    update.timezoneAuto = body.timezoneAuto;
  }
  // 「允许发通知邮件」：与语言/时区同一条 PUT，但它不是浏览器检测值，`detect` 不碰它。
  if ('mailOptIn' in body) {
    if (typeof body.mailOptIn !== 'boolean') return errorResponse('mailOptIn must be a boolean', 400);
    update.mailOptIn = body.mailOptIn;
  }

  if (
    update.locale === undefined &&
    update.localeAuto === undefined &&
    update.timezone === undefined &&
    update.timezoneAuto === undefined &&
    update.mailOptIn === undefined
  ) {
    return errorResponse('at least one preference field is required', 400);
  }

  await saveUserPreferences(env.DB, currentUser.id, update);
  // 认证路径缓存着整行 user，偏好变了必须让它失效，否则后续发信用到的还是旧值。
  AuthService.invalidateUserCache(currentUser.id);
  return respondWithFreshPreferences(env, currentUser.id);
}

// POST /api/accounts/preferences/detect
//
// 与 PUT 相反，这里**宽松**处理非法值：它们来自浏览器而不是用户，报 400 也无从补救，
// 跳过即可 —— 响应里的 `*Written` 已经告诉前端到底写没写。
// 真正的写入是条件写（未设定，或当前是自动档且值真的变了），见 `detectUserPreferences`。
export async function handleDetectPreferences(
  request: Request,
  env: Env,
  currentUser: User
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return errorResponse('Invalid JSON', 400);

  const detected = {
    locale: matchMailLocale(body.locale),
    timezone: isValidTimeZone(body.timezone) ? body.timezone.trim() : null,
  };

  const written = await detectUserPreferences(env.DB, currentUser.id, detected);
  if (written.localeWritten || written.timezoneWritten) {
    AuthService.invalidateUserCache(currentUser.id);
  }

  const user = await new StorageService(env.DB).getUserById(currentUser.id);
  if (!user) return errorResponse('User not found', 404);
  return jsonResponse({ ...preferencesResponse(user), ...written });
}

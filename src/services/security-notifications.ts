/**
 * 安全通知邮件。
 *
 * 映射表集中在这里，handler 侧用 `auditAndNotify(env, {...})` 代替 `safeWriteAuditEvent`：
 * 一处覆盖所有事件，且「这一操作会发信」在调用点可见。不挂在审计层内部（会形成循环依赖）。
 *
 * 三道门禁：`users.mail_opt_in` → `users.email_verified` → 全局发信可用；任一道不过就静默丢弃。
 * **不做发件数量限制**：额度归邮件服务商，自建配额会成为攻击者的静音开关。故本模块无状态。
 * 正文只有「发生了什么 + 时间 / IP / 来源地区（登录事件另加设备与类型）」，
 * 不含保管库内容、条目数量或用户可控文本。
 */
import { waitUntil } from 'cloudflare:workers';

import type { Env, User } from '../types';
import { safeWriteAuditEvent, type AuditEventInput } from './audit-events';
import { renderNotificationEmail, type NotificationEventKey } from './mail';
import { isMailDeliveryAvailable, resolveMailConnection, resolveMailRenderPreferences } from './mail-settings';
import { sendSmtpMail } from './smtp-client';
import { StorageService } from './storage';

/**
 * 审计动作 → 通知事件。
 *
 * **不在表里的动作一律不通知**，所以这里同时扮演白名单的角色。
 * 刻意排除的几类：
 * - `account.api_key.view`（info 级，只是查看）；
 * - `account.keys.update`（改加密密钥对，属主密码修改的连带动作，会重复通知）；
 * - `account.passkey.encryption.enable`（需要该 passkey 的实物断言，且它紧跟在创建之后，
 *   再发一封就是「一个动作两封信」）；
 * - `account.verify_devices.update.rejected`（该功能未实现，`enabled: true` 直接 400 且不改状态）；
 * - `system.yubico.credentials.update`（改服务器的 Yubico 凭据，用户侧触发不了）；
 * - 管理员**启用**账户（恢复访问，不是风险）。
 */
const RULES: Record<string, NotificationEventKey> = {
  'user.password.change': 'master_password_changed',
  'account.totp.enable': 'two_step_enabled',
  'account.yubikey.enable': 'two_step_enabled',
  'account.webauthn_2fa.enable': 'two_step_enabled',
  'account.totp.disable': 'two_step_disabled',
  'account.yubikey.disable': 'two_step_disabled',
  'account.webauthn_2fa.disable': 'two_step_disabled',
  'account.webauthn_2fa.delete': 'two_step_disabled',
  'account.totp.recover': 'two_step_recovery_used',
  // 恢复码首次铸出（每次打开设置页都会调那个端点，所以只在生成时发）
  'account.totp.recovery.create': 'two_step_recovery_created',
  // 登录方式：passkey 是「用什么登录」，与上面的两步登录因素是两回事。
  // 攻击者给自己加一枚等于留了个持久后门，必须通知。
  'account.passkey.create': 'passkey_created',
  'account.passkey.delete': 'passkey_deleted',
  'account.api_key.create': 'api_key_created',
  'account.api_key.rotate': 'api_key_rotated',
  'admin.user.status': 'account_disabled',
  'admin.user.delete': 'account_deleted',
  // 登录事件：命中后还要看「设备 / 地区是不是新的」才决定发不发，见 resolveNewSignInSignals
  'auth.login.success': 'new_sign_in',
  'auth.passkey.login.success': 'new_sign_in',
};

/**
 * 收件人快照。
 *
 * 账户被**删除**后用户行就查不到了，只能靠删除前写进审计元数据的这份副本。
 */
export function notificationRecipientSnapshot(
  user: Pick<User, 'email' | 'mailOptIn' | 'emailVerified'>
): Record<string, unknown> {
  return {
    recipientEmail: user.email ?? null,
    recipientOptIn: user.mailOptIn === true,
    recipientVerified: user.emailVerified === true,
  };
}

/** 从审计元数据里读字符串；空白串按「没有」处理。 */
function readMetaString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readMetaBoolean(metadata: Record<string, unknown> | null | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

/** 命中映射表且满足条件时返回该发的事件，否则 `null`。 */
function resolveNotificationEvent(event: AuditEventInput): NotificationEventKey | null {
  // `admin.user.status` 同时表示禁用与启用：只有禁用才是风险，启用是恢复访问
  if (event.action === 'admin.user.status') {
    return readMetaString(event.metadata, 'status') === 'banned' ? 'account_disabled' : null;
  }
  return RULES[event.action] ?? null;
}

/**
 * 收件人是谁：管理员禁用/删除**他人**账户时操作者是管理员，但该告知的是被操作的那个人 ——
 * 照 `actorUserId` 发信会把邮件发给管理员自己。
 */
function resolveRecipient(event: AuditEventInput): string | null {
  const actorUserId = event.actorUserId ?? null;
  if (event.targetType === 'user' && event.targetId && event.targetId !== actorUserId) {
    return event.targetId;
  }
  return actorUserId;
}

function readMetaNumber(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 见过多少个不同国家之后就不再为该用户做地区判定。
 *
 * 超过这个数说明账号本身就在频繁跨国（或被代理 IP 刷），继续判定只会制造噪声。
 */
const MAX_TRACKED_COUNTRIES = 20;

function countriesConfigKey(userId: string): string {
  return `securityNotify__countries__${userId}`;
}

function parseCountryList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 这个国家是不是首次出现；是则记进历史。
 *
 * 集合为空（首次登录）时只建立基线、返回 `false` —— 否则每个新用户收到的第一封邮件都是噪声。
 */
async function rememberCountry(storage: StorageService, userId: string, country: string): Promise<boolean> {
  const key = countriesConfigKey(userId);
  const known = parseCountryList(await storage.getConfigValue(key));
  if (known.length >= MAX_TRACKED_COUNTRIES || known.includes(country)) return false;
  await storage.setConfigValue(key, JSON.stringify([...known, country]));
  return known.length > 0;
}

interface SignInSignals {
  isNewDevice: boolean;
  isNewLocation: boolean;
}

async function resolveNewSignInSignals(
  storage: StorageService,
  userId: string,
  metadata: Record<string, unknown> | null | undefined
): Promise<SignInSignals> {
  const location = readMetaString(metadata, 'country');
  const flaggedNewDevice = readMetaBoolean(metadata, 'newDevice');

  // 全新用户的第一个设备必然是「新设备」，为此发提醒没有意义
  const devices = flaggedNewDevice ? await storage.getDevicesByUserId(userId) : [];

  return {
    isNewDevice: flaggedNewDevice && devices.length > 1,
    isNewLocation: location ? await rememberCountry(storage, userId, location) : false,
  };
}

/**
 * 写审计，并在命中映射表时给相关用户发一封安全通知。
 *
 * 关键操作之后请用它替换 `safeWriteAuditEvent`（其余普通事件保持不变）。
 */
export async function auditAndNotify(env: Env, event: AuditEventInput): Promise<void> {
  await safeWriteAuditEvent(env, event);

  const notificationEvent = resolveNotificationEvent(event);
  const recipientUserId = notificationEvent ? resolveRecipient(event) : null;
  if (!notificationEvent || !recipientUserId) return;
  // 发信排在响应之后：waitUntil 只延长生命周期，不拖慢本次响应
  waitUntil(deliver(env, event, notificationEvent, recipientUserId));
}

async function deliver(
  env: Env,
  event: AuditEventInput,
  notificationEvent: NotificationEventKey,
  recipientUserId: string
): Promise<void> {
  try {
    const storage = new StorageService(env.DB);
    const recipient = await storage.getUserById(recipientUserId);
    const metadata = event.metadata;

    // 用户行还在时以库里的值为准；已被删除时退回删除前的快照
    const email = recipient ? recipient.email : readMetaString(metadata, 'recipientEmail');
    const optedIn = recipient ? recipient.mailOptIn === true : readMetaBoolean(metadata, 'recipientOptIn');
    const verified = recipient ? recipient.emailVerified === true : readMetaBoolean(metadata, 'recipientVerified');
    if (!email || !optedIn || !verified) return;

    if (!(await isMailDeliveryAvailable(env.DB, env))) return;
    const connection = await resolveMailConnection(env.DB, env);
    if (connection.status !== 'ok') return;

    // 登录事件还要看「设备 / 地区是不是新的」——都不是就别打扰用户
    const signIn = notificationEvent === 'new_sign_in'
      ? await resolveNewSignInSignals(storage, recipientUserId, metadata)
      : null;
    if (signIn && !signIn.isNewDevice && !signIn.isNewLocation) return;

    const mail = renderNotificationEmail(
      {
        // 时间取「现在」：通知紧跟事件产生，审计行里的时间也是这一刻
        event: notificationEvent,
        occurredAt: new Date(),
        ip: readMetaString(metadata, 'ip'),
        deviceName: readMetaString(metadata, 'deviceName'),
        deviceType: readMetaNumber(metadata, 'deviceType'),
        deviceIsNew: signIn?.isNewDevice,
        // 来源地区取自 `auditRequestMetadata()`，所以**所有**事件都有；
        // 地区名由渲染层按收件人语言本地化。「（新）」标记只属于登录事件。
        location: readMetaString(metadata, 'country'),
        locationIsNew: signIn?.isNewLocation,
      },
      resolveMailRenderPreferences(recipient ?? {})
    );

    await sendSmtpMail(connection.settings, {
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (error) {
    console.error('security notification delivery failed', error);
    await recordDeliveryFailure(env, notificationEvent, recipientUserId, error);
  }
}

/** 发信失败是静默的（用户不会知道自己没收到），不记一笔就完全看不见。 */
async function recordDeliveryFailure(
  env: Env,
  notificationEvent: NotificationEventKey,
  recipientUserId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await safeWriteAuditEvent(env, {
    actorUserId: recipientUserId,
    action: 'system.mail.notify.failed',
    category: 'system',
    level: 'error',
    targetType: 'user',
    targetId: recipientUserId,
    metadata: {
      type: notificationEvent,
      error: message.slice(0, 200),
    },
  });
}

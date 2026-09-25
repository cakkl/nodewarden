/**
 * 邮件模板的英文文案。
 *
 * 加新语言时：复制本文件、改 `MailCopy` 里的值，并在 `index.ts` 的 `COPY` 里注册。
 * 缺失的语言会回退到英文（见 `resolveMailCopy`）。
 */

/**
 * 安全通知覆盖的事件。
 *
 * 新增事件时只需在这里加键 —— `Record<NotificationEventKey, string>` 会在**编译期**
 * 拦住漏填的语言包，不需要额外的运行时护栏测试。
 * 短句同时嵌进主题与大标题，所以写成名词短语、不带句号。
 */
export type NotificationEventKey =
  | 'two_step_enabled'
  | 'two_step_disabled'
  | 'two_step_recovery_used'
  | 'api_key_created'
  | 'api_key_rotated'
  | 'master_password_changed'
  | 'account_disabled'
  | 'account_deleted'
  | 'new_sign_in'
  | 'two_step_recovery_created'
  | 'passkey_created'
  | 'passkey_deleted';

export interface MailCopy {
  /** 邮件顶部与页脚显示的产品名 */
  brand: string;
  test: {
    subject: string;
    heading: string;
    intro: string;
    detailsTitle: string;
    labels: { server: string; encryption: string; sentAt: string };
    outro: string;
  };
  /** 邮箱验证码。`expiresLabel` 后面会直接拼时间，各语言自己写成完整的前缀。 */
  verification: {
    subject: string;
    heading: string;
    intro: string;
    codeLabel: string;
    expiresLabel: string;
    outro: string;
  };
  /**
   * 安全通知。**单模板 + 事件名映射**：`events` 只提供「发生了什么」，其余文案十种语言共用。
   * `subject` / `heading` 里的 `{event}` 由对应短句填充；正文不含保管库内容或条目数量。
   */
  notifications: {
    subject: string;
    heading: string;
    intro: string;
    detailsTitle: string;
    labels: { time: string; ip: string; device: string; type: string; location: string };
    /** 收尾提醒：如非本人操作该怎么办 */
    disclaimer: string;
    /**
     * 管理员发起的事件（禁用 / 删除）专用的收尾提醒。
     *
     * 那两种情况下用户可能已经登不进去了，「改主密码、检查已授权设备」是做不到的建议。
     */
    adminDisclaimer: string;
    /**
     * 明细行里标记「本次是新出现的」，如「（新）」/「 (new)」。
     * **间距由译文自带**：拉丁字母语言需要前导空格，中日文用全角括号则不需要。
     */
    newMarker: string;
    /**
     * 设备类型名。键名与粒度都对齐网页端设备管理页
     *（`webapp/src/components/SecurityDevicesPage.tsx` 的 `mapDeviceTypeName`），
     * 让用户在邮件与界面里看到同一个词。
     */
    deviceTypes: {
      android: string;
      ios: string;
      chromeExtension: string;
      firefoxExtension: string;
      operaExtension: string;
      edgeExtension: string;
      windowsDesktop: string;
      macosDesktop: string;
      linuxDesktop: string;
      chromeBrowser: string;
      firefoxBrowser: string;
      operaBrowser: string;
      edgeBrowser: string;
      ieBrowser: string;
      web: string;
    };
    events: Record<NotificationEventKey, string>;
  };
  /** 页脚统一说明 */
  footer: string;
  /**
   * 收件人还没设定偏好时的提示句。
   *
   * ⚠️ `locale` / `both` **只可能用到英文那一份**：语言未设定 ⇒ 邮件就用默认语言（英文）渲染，
   * 于是选中的文案也是英文 ⇒ 其余 9 个语言包只需提供 `timezone`（所以那两项是可选的）。
   * `{timezone}` 由 `DEFAULT_MAIL_TIMEZONE` 填充，**别在文案里写死**。
   */
  preferencesNote: {
    /** 只缺时区（10 个语言包都要有） */
    timezone: string;
    /** 只缺语言（仅英文这一份可达） */
    locale?: string;
    /** 两个都缺（仅英文这一份可达） */
    both?: string;
  };
}

const en: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP test',
    heading: 'Your mail settings work',
    intro: 'This message was sent by NodeWarden to confirm that outgoing mail is configured correctly.',
    detailsTitle: 'Connection details',
    labels: { server: 'Server', encryption: 'Encryption', sentAt: 'Sent at' },
    outro: 'If you did not expect this message, someone with administrator access changed the mail settings.',
  },
  verification: {
    subject: 'Verify your NodeWarden email address',
    heading: 'Confirm your email address',
    intro: 'Enter this code in NodeWarden to confirm that this address belongs to you. Security notifications are only sent to a confirmed address.',
    codeLabel: 'Verification code',
    expiresLabel: 'This code expires at',
    outro: 'If you did not request this, ignore this message. Your address stays unconfirmed and no notifications will be sent.',
  },
  notifications: {
    subject: 'Security alert: {event}',
    heading: 'Security alert: {event}',
    intro: 'A change was just made to your NodeWarden account. The details are below.',
    detailsTitle: 'Details',
    labels: { time: 'Time', ip: 'IP address', device: 'Device', type: 'Type', location: 'Location' },
    disclaimer:
      'If you did not expect this change, someone else may have access to your account. '
      + 'Change your master password and review your authorized devices now.',
    adminDisclaimer: 'If you did not expect this change, contact an administrator immediately.',
    newMarker: ' (new)',
    deviceTypes: {
      android: 'Android',
      ios: 'iOS',
      chromeExtension: 'Chrome Extension',
      firefoxExtension: 'Firefox Extension',
      operaExtension: 'Opera Extension',
      edgeExtension: 'Edge Extension',
      windowsDesktop: 'Windows Desktop',
      macosDesktop: 'macOS Desktop',
      linuxDesktop: 'Linux Desktop',
      chromeBrowser: 'Chrome Browser',
      firefoxBrowser: 'Firefox Browser',
      operaBrowser: 'Opera Browser',
      edgeBrowser: 'Edge Browser',
      ieBrowser: 'IE Browser',
      web: 'Web',
    },
    events: {
      two_step_enabled: 'Two-step login turned on',
      two_step_disabled: 'Two-step login turned off',
      two_step_recovery_used: 'Two-step login recovery code used',
      api_key_created: 'API key created',
      api_key_rotated: 'API key rotated',
      master_password_changed: 'Master password changed',
      account_disabled: 'Account disabled by an administrator',
      account_deleted: 'Account deleted by an administrator',
      new_sign_in: 'Sign-in from a new device or location',
      two_step_recovery_created: 'Two-step login recovery code created',
      passkey_created: 'Sign-in passkey created',
      passkey_deleted: 'Sign-in passkey deleted',
    },
  },
  preferencesNote: {
    timezone:
      'Note: you have not set a timezone yet, so times above are shown in {timezone}. Set yours in Settings → Preferences.',
    locale:
      'Note: you have not set your language yet, so this email uses the default language (English). Set it in Settings → Preferences.',
    both:
      'Note: you have not set your language or timezone yet, so this email uses the default language (English) and shows times in {timezone}. Set both in Settings → Preferences.',
  },
  footer: 'Sent automatically by NodeWarden. Replies to this address are not monitored.',
};

export default en;

/**
 * 邮件模板。每个模板输出三件套：主题、纯文本正文、HTML 正文。
 *
 * 纯文本不是可选项：部分客户端（以及可访问性工具）只读 `text/plain`，
 * 而且它是 HTML 被拦截时的兜底。两者必须表达同样的信息。
 */
import type { MailCopy, NotificationEventKey } from './locales/en';
import { mailCodeBlock, mailDetailBlock, mailParagraph, renderMailLayout } from './layout';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface TestMailInput {
  host: string;
  port: number;
  encryption: 'implicit' | 'starttls';
  sentAt: Date;
}

export interface VerificationMailInput {
  code: string;
  expiresAt: Date;
}

export interface NotificationMailInput {
  /**
   * 发生了什么。取值是**语言包里的固定枚举**（`NotificationEventKey`），
   * 不是任意字符串 —— 正文里不能出现调用方拼出来的内容。
   */
  event: NotificationEventKey;
  occurredAt: Date;
  /** 触发事件的来源 IP；拿不到时传 `null`，明细里省掉这一行。 */
  ip?: string | null;
}

/** 渲染选项：语言与时区都来自**收件人偏好**，不是写死的。 */
export interface MailRenderContext {
  locale?: string;
  /** IANA 时区名；决定正文里时间的显示时区 */
  timezone?: string;
  /** 哪一项用的是回退值 —— 模板据此在正文追加提示句（见 `preferencesNoteFor`） */
  preferencesUnset?: { locale: boolean; timezone: boolean };
}

/**
 * 邮件时间的回退时区（收件人未设定时）。
 *
 * 定义在本文件而不是 `mail-settings.ts`：那边已经 import `./mail`，反向依赖会形成循环。
 */
export const DEFAULT_MAIL_TIMEZONE = 'UTC';

/**
 * 按指定时区格式化时间。
 *
 * 刻意**不带**时区标识（如 `GMT+8`）：时区取自收件人自己的偏好，再标一遍只是噪声。
 * 时区名非法时回退 UTC（外层已校验过，这里是二道防线）。
 */
export function formatMailTime(date: Date, timezone?: string): string {
  const zone = String(timezone || '').trim() || DEFAULT_MAIL_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const pick = (type: string): string => parts.find((part) => part.type === type)?.value || '';
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
  } catch {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} ${DEFAULT_MAIL_TIMEZONE}`;
  }
}

/** `{timezone}` 用实际回退值填充，免得常量改了文案却不变。 */
function fillTimezonePlaceholder(template: string): string {
  return template.replace('{timezone}', DEFAULT_MAIL_TIMEZONE);
}

/**
 * 收件人尚未设定偏好时的提示句；没有缺项则返回 `null`。
 *
 * 三选一：只缺语言 ⇒ `locale`；只缺时区 ⇒ `timezone`；两个都缺 ⇒ `both`。
 * `locale` / `both` **只可能是英文**：语言未设定 ⇒ 邮件用默认语言（英文）渲染 ⇒
 * 其余 9 个语言包只需提供 `timezone`（接口里那两项可选）。
 * 这里仍写兜底链，避免将来只填一部分时渲染出空行。
 */
function preferencesNoteFor(
  copy: MailCopy,
  unset?: MailRenderContext['preferencesUnset']
): string | null {
  if (!unset) return null;
  const note = copy.preferencesNote;
  if (unset.locale && unset.timezone) return fillTimezonePlaceholder(note.both ?? note.locale ?? note.timezone);
  if (unset.locale) return fillTimezonePlaceholder(note.locale ?? note.timezone);
  if (unset.timezone) return fillTimezonePlaceholder(note.timezone);
  return null;
}

/** `{event}` 用 `events` 里对应的短句填充。 */
function fillEventPlaceholder(template: string, eventLabel: string): string {
  return template.replace('{event}', eventLabel);
}

/** 测试邮件：证明发信链路可用，并回显本次使用的连接参数。 */
export function renderTestMail(
  copy: MailCopy,
  input: TestMailInput,
  context: MailRenderContext = {}
): RenderedMail {
  const locale = context.locale;
  // 协议名保持英文：它在各国界面里也是这么写的
  const encryption = input.encryption === 'implicit' ? 'Implicit TLS' : 'STARTTLS';
  const sentAt = formatMailTime(input.sentAt, context.timezone);
  const preferencesNote = preferencesNoteFor(copy, context.preferencesUnset);
  const rows: Array<[string, string]> = [
    [copy.test.labels.server, `${input.host}:${input.port}`],
    [copy.test.labels.encryption, encryption],
    [copy.test.labels.sentAt, sentAt],
  ];

  return {
    subject: copy.test.subject,
    html: renderMailLayout({
      brand: copy.brand,
      lang: locale,
      heading: copy.test.heading,
      bodyHtml:
        mailParagraph(copy.test.intro) +
        mailDetailBlock(copy.test.detailsTitle, rows) +
        mailParagraph(copy.test.outro, { muted: true }) +
        (preferencesNote ? mailParagraph(preferencesNote, { muted: true }) : ''),
      footer: copy.footer,
    }),
    text: [
      copy.test.heading,
      '',
      copy.test.intro,
      '',
      `${copy.test.detailsTitle}:`,
      ...rows.map(([label, value]) => `- ${label}: ${value}`),
      '',
      copy.test.outro,
      ...(preferencesNote ? ['', preferencesNote] : []),
      '',
      copy.footer,
    ].join('\n'),
  };
}

/** 邮箱验证码邮件。码是唯一需要用户动手的东西，正文里给它最高视觉权重。 */
export function renderVerificationMail(
  copy: MailCopy,
  input: VerificationMailInput,
  context: MailRenderContext = {}
): RenderedMail {
  const expiresAt = formatMailTime(input.expiresAt, context.timezone);
  const expiryLine = `${copy.verification.expiresLabel} ${expiresAt}`;
  const preferencesNote = preferencesNoteFor(copy, context.preferencesUnset);

  return {
    subject: copy.verification.subject,
    html: renderMailLayout({
      brand: copy.brand,
      lang: context.locale,
      heading: copy.verification.heading,
      bodyHtml:
        mailParagraph(copy.verification.intro) +
        mailCodeBlock(copy.verification.codeLabel, input.code) +
        mailParagraph(expiryLine, { muted: true }) +
        mailParagraph(copy.verification.outro, { muted: true }) +
        (preferencesNote ? mailParagraph(preferencesNote, { muted: true }) : ''),
      footer: copy.footer,
    }),
    text: [
      copy.verification.heading,
      '',
      copy.verification.intro,
      '',
      `${copy.verification.codeLabel}: ${input.code}`,
      expiryLine,
      '',
      copy.verification.outro,
      ...(preferencesNote ? ['', preferencesNote] : []),
      '',
      copy.footer,
    ].join('\n'),
  };
}

/**
 * 由管理员发起的事件：此时用户可能已经登不进去了，
 * 「改主密码、检查已授权设备」是做不到的建议。
 */
const ADMIN_INITIATED_EVENTS: ReadonlySet<NotificationEventKey> = new Set([
  'account_disabled',
  'account_deleted',
]);

/** 安全通知：只描述「发生了什么 + 时间 + IP」，不含保管库内容或用户可控文本。 */
export function renderNotificationMail(
  copy: MailCopy,
  input: NotificationMailInput,
  context: MailRenderContext = {}
): RenderedMail {
  // 类型上 `events` 不会缺键，这里是二道防线：宁可显示键名，也不要渲染出 `undefined`
  const eventLabel = copy.notifications.events[input.event] || input.event;
  const preferencesNote = preferencesNoteFor(copy, context.preferencesUnset);
  const disclaimer = ADMIN_INITIATED_EVENTS.has(input.event)
    ? copy.notifications.adminDisclaimer
    : copy.notifications.disclaimer;
  const rows: Array<[string, string]> = [
    [copy.notifications.labels.time, formatMailTime(input.occurredAt, context.timezone)],
  ];
  if (input.ip) rows.push([copy.notifications.labels.ip, input.ip]);

  return {
    subject: fillEventPlaceholder(copy.notifications.subject, eventLabel),
    html: renderMailLayout({
      brand: copy.brand,
      lang: context.locale,
      heading: fillEventPlaceholder(copy.notifications.heading, eventLabel),
      bodyHtml:
        mailParagraph(copy.notifications.intro) +
        mailDetailBlock(copy.notifications.detailsTitle, rows) +
        mailParagraph(disclaimer, { muted: true }) +
        (preferencesNote ? mailParagraph(preferencesNote, { muted: true }) : ''),
      footer: copy.footer,
    }),
    text: [
      fillEventPlaceholder(copy.notifications.heading, eventLabel),
      '',
      copy.notifications.intro,
      '',
      `${copy.notifications.detailsTitle}:`,
      ...rows.map(([label, value]) => `- ${label}: ${value}`),
      '',
      disclaimer,
      ...(preferencesNote ? ['', preferencesNote] : []),
      '',
      copy.footer,
    ].join('\n'),
  };
}

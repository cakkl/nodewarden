/**
 * 邮件模板。每个模板输出三件套：主题、纯文本正文、HTML 正文。
 *
 * 纯文本不是可选项：部分客户端（以及可访问性工具）只读 `text/plain`，
 * 而且它是 HTML 被拦截时的兜底。两者必须表达同样的信息。
 */
import type { MailCopy } from './locales/en';
import { mailDetailBlock, mailParagraph, renderMailLayout } from './layout';

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

/** 渲染选项：语言与时区都来自邮件设置，不是写死的。 */
export interface MailRenderContext {
  locale?: string;
  /** IANA 时区名；决定正文里时间的显示时区 */
  timezone?: string;
}

/**
 * 按指定时区格式化时间，并带上时区标识（如 `2026-09-21 15:45 GMT+8`）。
 *
 * 带上标识很重要：收件人未必与该时区一致，只说 `15:45` 会让人误判。
 * 时区名非法时回退 UTC（外层已经校验过，这里是二道防线）。
 */
export function formatMailTime(date: Date, timezone?: string): string {
  const zone = String(timezone || '').trim() || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).formatToParts(date);
    const pick = (type: string): string => parts.find((part) => part.type === type)?.value || '';
    const stamp = `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
    const name = pick('timeZoneName');
    return name ? `${stamp} ${name}` : stamp;
  } catch {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
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
        mailParagraph(copy.test.outro, { muted: true }),
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
      '',
      copy.footer,
    ].join('\n'),
  };
}

/**
 * 邮件 HTML 外壳。
 *
 * 约束（邮件客户端比浏览器苛刻得多）：
 * - **table 布局**：Outlook 等客户端对 flex / grid 支持很差，表格最稳。
 * - **全部内联样式**：很多客户端会剥掉 `<style>`，所以颜色与间距都写在元素上。
 * - **不能引用 CSS 变量**：取值与 `webapp/src/styles/tokens.css` 保持一致，但必须是字面量。
 *   改颜色时两边要一起看，否则邮件与界面会脱节。
 * - 宽度用 `max-width: 560px` + 100% 表格，窄屏自动收缩。
 */

/** 与 tokens.css 对齐的品牌色（邮件里必须是字面量） */
const COLOR = {
  pageBg: '#f3f6f9',
  cardBg: '#ffffff',
  softBg: '#fbfcfe',
  insetBg: '#f8fafc',
  line: 'rgba(100, 116, 139, 0.24)',
  lineSoft: 'rgba(100, 116, 139, 0.14)',
  heading: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  brand: '#1e40af',
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, " +
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export interface MailLayoutOptions {
  brand: string;
  /** 用于 `<html lang>`，让屏幕阅读器与客户端选对字体与断行规则 */
  lang?: string;
  heading: string;
  /** 已是 HTML 的正文片段（由调用方负责转义动态内容） */
  bodyHtml: string;
  footer: string;
}

export function renderMailLayout({ brand, lang, heading, bodyHtml, footer }: MailLayoutOptions): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:${COLOR.pageBg};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;max-width:560px;background:${COLOR.cardBg};border:1px solid ${COLOR.line};border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:18px 28px;background:${COLOR.softBg};border-bottom:1px solid ${COLOR.lineSoft};">
            <span style="font-size:16px;font-weight:700;letter-spacing:-0.01em;color:${COLOR.brand};">${escapeHtml(brand)}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.35;font-weight:700;color:${COLOR.heading};">${escapeHtml(heading)}</h1>
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px;background:${COLOR.softBg};border-top:1px solid ${COLOR.lineSoft};">
            <p style="margin:0;font-size:12px;line-height:1.6;color:${COLOR.muted};">${escapeHtml(footer)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** 正文段落 */
export function mailParagraph(text: string, options: { muted?: boolean } = {}): string {
  const color = options.muted ? COLOR.muted : COLOR.body;
  const size = options.muted ? '13px' : '15px';
  return `<p style="margin:0 0 16px;font-size:${size};line-height:1.65;color:${color};">${escapeHtml(text)}</p>`;
}

/** 带标题的键值区块（用于「连接详情」这类信息） */
export function mailDetailBlock(title: string, rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr>` +
        `<td style="padding:0 12px 8px 0;font-size:13px;line-height:1.5;color:${COLOR.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td style="padding:0 0 8px;font-size:13px;line-height:1.5;color:${COLOR.body};word-break:break-all;">${escapeHtml(value)}</td>` +
        `</tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:${COLOR.insetBg};border-radius:10px;margin:0 0 18px;">
  <tr><td style="padding:16px 18px 8px;">
    <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${COLOR.muted};">${escapeHtml(title)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${body}</table>
  </td></tr>
</table>`;
}

/** 大字号验证码区块：收件人要能一眼抄下来，所以字号远大于正文。 */
export function mailCodeBlock(label: string, code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:${COLOR.insetBg};border-radius:10px;margin:0 0 18px;">
  <tr><td align="center" style="padding:20px 18px;">
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${COLOR.muted};">${escapeHtml(label)}</p>
    <p style="margin:0;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:0.18em;color:${COLOR.heading};font-family:${FONT_STACK};">${escapeHtml(code)}</p>
  </td></tr>
</table>`;
}

/** 所有动态文本都必须过这一层 —— 邮件正文同样可能被注入标签 */
export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

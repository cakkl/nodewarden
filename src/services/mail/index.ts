/**
 * 邮件模板的渲染入口。
 *
 * 语言按**收件人偏好**解析；缺失或未知一律回退英文 —— 绝不因为语言不认识就发不出去信。
 */
import en, { type MailCopy } from './locales/en';
import zhCN from './locales/zh-CN';
import zhTW from './locales/zh-TW';
import ru from './locales/ru';
import es from './locales/es';
import fi from './locales/fi';
import de from './locales/de';
import fr from './locales/fr';
import it from './locales/it';
import sv from './locales/sv';
import { renderTestMail, renderVerificationMail, renderNotificationMail, DEFAULT_MAIL_TIMEZONE, type MailRenderContext, type NotificationMailInput, type RenderedMail, type TestMailInput, type VerificationMailInput } from './templates';

export type MailLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ru' | 'es' | 'fi' | 'de' | 'fr' | 'it' | 'sv';

export const DEFAULT_MAIL_LOCALE: MailLocale = 'en';

const COPY: Record<MailLocale, MailCopy> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ru,
  es,
  fi,
  de,
  fr,
  it,
  sv,
};

/**
 * 支持的语言清单（从模板表派生）。
 * 前端 `AVAILABLE_LOCALES` 必须与 `MailLocale` 逐项一致（有护栏测试盯着）。
 */
const MAIL_LOCALES = Object.keys(COPY) as readonly MailLocale[];

export function resolveMailCopy(locale?: unknown): { locale: MailLocale; copy: MailCopy } {
  const resolved = matchMailLocale(locale) ?? DEFAULT_MAIL_LOCALE;
  return { locale: resolved, copy: COPY[resolved] };
}

/**
 * 大小写不敏感地匹配到清单里的标准写法；匹配不上返回 `null`。
 *
 * 与 `resolveMailCopy` 的区别：那个**总要**给出一份可用的文案（回退英文），
 * 而这里要把「认不出来」告诉调用方 —— 用户级偏好需要它来判断「是不是未设定」。
 */
export function matchMailLocale(value: unknown): MailLocale | null {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  return MAIL_LOCALES.find((item) => item.toLowerCase() === needle) ?? null;
}

export function renderTestEmail(
  input: TestMailInput,
  context: MailRenderContext = {}
): RenderedMail & { locale: MailLocale } {
  const { locale: resolved, copy } = resolveMailCopy(context.locale);
  return { ...renderTestMail(copy, input, { ...context, locale: resolved }), locale: resolved };
}

export function renderVerificationEmail(
  input: VerificationMailInput,
  context: MailRenderContext = {}
): RenderedMail & { locale: MailLocale } {
  const { locale: resolved, copy } = resolveMailCopy(context.locale);
  return { ...renderVerificationMail(copy, input, { ...context, locale: resolved }), locale: resolved };
}

/** 安全通知：事件名取自语言包枚举，语言与时区都按收件人偏好解析。 */
export function renderNotificationEmail(
  input: NotificationMailInput,
  context: MailRenderContext = {}
): RenderedMail & { locale: MailLocale } {
  const { locale: resolved, copy } = resolveMailCopy(context.locale);
  return { ...renderNotificationMail(copy, input, { ...context, locale: resolved }), locale: resolved };
}

export type { NotificationEventKey } from './locales/en';
export type { MailCopy, MailRenderContext, NotificationMailInput, RenderedMail, TestMailInput, VerificationMailInput };

/** 转发自 `templates.ts`：提示句里的 `{timezone}` 需要它填充。 */
export { DEFAULT_MAIL_TIMEZONE };

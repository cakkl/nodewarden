/**
 * 邮件模板的渲染入口。
 *
 * 语言按「收件人偏好 → 站点默认」解析；缺失或未知语言一律回退英文，
 * 绝不因为语言不认识就发不出去信。
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
import { renderTestMail, type MailRenderContext, type RenderedMail, type TestMailInput } from './templates';

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

export function resolveMailCopy(locale?: unknown): { locale: MailLocale; copy: MailCopy } {
  const normalized = String(locale || '').trim().toLowerCase();
  const matched = (Object.keys(COPY) as MailLocale[]).find((key) => key.toLowerCase() === normalized);
  const resolved = matched ?? DEFAULT_MAIL_LOCALE;
  return { locale: resolved, copy: COPY[resolved] };
}

export function renderTestEmail(
  input: TestMailInput,
  context: MailRenderContext = {}
): RenderedMail & { locale: MailLocale } {
  const { locale: resolved, copy } = resolveMailCopy(context.locale);
  return { ...renderTestMail(copy, input, { ...context, locale: resolved }), locale: resolved };
}

export type { MailCopy, MailRenderContext, RenderedMail, TestMailInput };

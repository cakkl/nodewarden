// 离线兜底页（`sw.js` 里那段写死的 HTML）的文案表，构建时内联进 Service Worker。
// 值取自各语言表的同一键；加语言时这里要跟着加（有护栏核对）。
// 单列一份的理由：兜底页出现时语言包一个都没缓存，运行时无从加载 i18n。
import de from './i18n/locales/de';
import en from './i18n/locales/en';
import es from './i18n/locales/es';
import fi from './i18n/locales/fi';
import fr from './i18n/locales/fr';
import it from './i18n/locales/it';
import ru from './i18n/locales/ru';
import sv from './i18n/locales/sv';
import zhCN from './i18n/locales/zh-CN';
import zhTW from './i18n/locales/zh-TW';

/** 与各语言表里的键同名。 */
const MESSAGE_KEY = 'txt_pwa_offline_fallback';

export const OFFLINE_FALLBACK_MESSAGES: Record<string, string> = {
  en: en[MESSAGE_KEY],
  'zh-CN': zhCN[MESSAGE_KEY],
  'zh-TW': zhTW[MESSAGE_KEY],
  ru: ru[MESSAGE_KEY],
  es: es[MESSAGE_KEY],
  fi: fi[MESSAGE_KEY],
  de: de[MESSAGE_KEY],
  fr: fr[MESSAGE_KEY],
  it: it[MESSAGE_KEY],
  sv: sv[MESSAGE_KEY],
};

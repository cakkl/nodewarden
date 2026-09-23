const fs = require('node:fs');
const path = require('node:path');

const { localeFiles, readLocale, localeDir } = require('./i18n-utils.cjs');

// i18n.ts 的 localeLoaders 是语言集合的权威来源；i18n-utils.cjs 里手写的列表
// 只描述「每个语言对应哪个文件」。两者必须一致，见下方的显式比对。
const i18nEntry = path.join(__dirname, '..', 'webapp', 'src', 'lib', 'i18n.ts');

// CONTRACT:
// This is the authoritative locale consistency gate. It checks key parity,
// placeholder parity, and accidentally untranslated locales. Run after any
// user-facing text or locale-file change.
//
// 「没翻译」的判定只依赖两个自洽的信号，不再靠手工维护键白名单：
// - 连续相同段（主）：未翻译的内容是成片复制的，同形词凑不出长段；
// - 相同值比例（次）：随词表规模增长，以后不必再手工调数字。
// 同形词（Password / Account / IBAN / S3）由 sharedLoanwords 自动豁免。
const locales = Object.fromEntries(
  localeFiles.map(([locale, fileName, variableName]) => [locale, readLocale(fileName, variableName)])
);
const base = locales.en;
const baseKeys = Object.keys(base).sort();
const placeholderRe = /\{\w+\}/g;
const errors = [];

// 读取 i18n.ts 中的 localeLoaders，返回 Map<locale, fileName|null>。
// fileName 为 null 表示该 loader 不是动态 import（例如 en 走静态导入）。
// 按行解析而非正则跨行匹配：声明行含有 `=>`，正则会被类型里的等号干扰。
function readI18nLoaderLocales() {
  const lines = fs.readFileSync(i18nEntry, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.includes('localeLoaders') && line.includes('= {'));
  if (start === -1) return null;

  const entries = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '};') break;
    const match = line.match(/^\s*(?:'([^']+)'|([A-Za-z][\w-]*))\s*:\s*(.+?),?\s*$/);
    if (!match) continue;
    const locale = match[1] || match[2];
    const importMatch = match[3].match(/import\('\.\/i18n\/locales\/([^']+)'\)/);
    entries.set(locale, importMatch ? `${importMatch[1]}.ts` : null);
  }
  return entries;
}

// 语种集合必须与 i18n.ts 一致。若只改了 i18n.ts 而漏改 i18n-utils.cjs，新语言会被
// 本脚本静默跳过（不报错、假绿），因此这里显式报错。
const loaderLocales = readI18nLoaderLocales();
if (!loaderLocales || loaderLocales.size === 0) {
  errors.push({ locale: 'i18n.ts', problem: 'could not read localeLoaders', file: i18nEntry });
} else {
  const declared = localeFiles.map(([locale]) => locale);
  const missingInUtils = [...loaderLocales.keys()].filter((locale) => !declared.includes(locale));
  const extraInUtils = declared.filter((locale) => !loaderLocales.has(locale));
  if (missingInUtils.length || extraInUtils.length) {
    errors.push({
      locale: 'i18n.ts',
      problem: 'locale list out of sync with scripts/i18n-utils.cjs',
      missingInUtils,
      extraInUtils,
    });
  }
  for (const [locale, fileName] of loaderLocales) {
    if (fileName && !fs.existsSync(path.join(localeDir, fileName))) {
      errors.push({ locale, problem: `locale file not found: ${fileName}` });
    }
  }
}
const intentionallyEnglishKeys = new Set([
  'txt_backup_destination_detail_note',
  'txt_backup_protocol_webdav',
  'txt_backup_protocol_s3',
  'txt_backup_recommend_group_webdav',
  'txt_backup_recommend_group_s3',
  'txt_backup_destination_name_default_webdav',
  'txt_backup_destination_name_default_s3',
  // 邮件设置：协议名与端口在多种语言里本就写作英文（如 de/fr/sv 的 "Port"、it 的 "Password"）
  'txt_mail_port',
  'txt_mail_password',
  'txt_mail_encryption_starttls',
  'txt_mail_encryption_implicit',
  'txt_dash',
  'txt_text_3',
]);
const intentionallyEnglishPrefixes = [
  'txt_log_action_',
  'txt_log_meta_',
  'txt_log_reason_',
  'txt_log_target_type_',
  'txt_log_trigger_',
];

function isIntentionallyEnglishKey(key) {
  return intentionallyEnglishKeys.has(key) || intentionallyEnglishPrefixes.some((prefix) => key.startsWith(prefix));
}

// 跨语言同形词：技术借用词、协议名、平台名。它们在多数语言里本来就这么写，
// 与「没翻译」不是一回事。按「值」判定而不是按「键」判定 —— 否则每遇到一个
// 合法的同形词就得往 intentionallyEnglishKeys 里手工加一行，而那只是迁就。
//
// 只收技术性/专有性的词。刻意**不**收 the/and/to 这类英语常用词：它们出现在
// 正文里往往真的意味着漏翻，放进来等于放水。
const sharedLoanwords = new Set([
  'account', 'active', 'admin', 'android', 'api', 'auto', 'backup', 'bucket',
  'chrome', 'client', 'credentials', 'debug', 'dash', 'download', 'duo', 'edge',
  'email', 'export', 'file', 'files', 'firefox', 'folder', 'grant', 'host',
  'hosted', 'http', 'https', 'iban', 'id', 'ids', 'idle', 'implicit', 'import',
  'info', 'ios', 'jwt', 'kofi', 'koofr', 'level', 'linux', 'log', 'macos',
  'master', 'menu', 'nfc', 'no', 'none', 'oauth', 'off', 'offline', 'ok', 'on',
  'online', 'otp', 'passkey', 'passkeys', 'password', 'passwords', 'path', 'port',
  'restore', 'role', 's3', 'safari', 'secret', 'self', 'server', 'smtp', 'ssl',
  'starttls', 'status', 'sync', 'tls', 'token', 'totp', 'type', 'upload', 'uri',
  'url', 'webauthn', 'webdav', 'windows', 'yubikey',
]);

/**
 * 该值是否「本来就不该翻译」。
 *
 * 判定分两层：
 * - 纯符号/纯数字（`-`、`—`、`1`）没有语言之分；
 * - 全部由同形词组成的短语（`Master Password`、`Client ID`、`Implicit TLS`）。
 *   按词拆分判定，所以短语能自动命中，不需要为每种组合单独登记。
 */
function isNonTranslatableValue(value) {
  const text = String(value).trim();
  if (!text) return true;
  // 不含任何字母 ⇒ 符号、数字、分隔符
  if (!/\p{L}/u.test(text)) return true;
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
  // 纯数字词（端口号、年份）没有语言之分，与同形词同等对待
  return words.length > 0 && words.every((word) => sharedLoanwords.has(word) || /^\d+$/.test(word));
}

/**
 * 连续相同的最长段落。
 *
 * 这是「整块没翻译」的真实特征：新加一种语言或一段功能时，那批键会被整段复制过来，
 * 形成长段。同形词是零星散布的，凑不出长段，因此不会误报。
 *
 * 已豁免的键视为中断 —— 它本来就合法，不构成未翻译的迹象。
 */
function longestUntranslatedRun(localeTable) {
  let best = { length: 0, start: 0 };
  let current = 0;
  for (let i = 0; i < baseKeys.length; i += 1) {
    const key = baseKeys[i];
    const identical = localeTable[key] === base[key];
    if (identical && !isIntentionallyEnglishKey(key) && !isNonTranslatableValue(base[key])) {
      current += 1;
      if (current > best.length) best = { length: current, start: i - current + 1 };
    } else {
      current = 0;
    }
  }
  return best;
}

for (const [locale, table] of Object.entries(locales)) {
  const keys = Object.keys(table).sort();
  const missing = baseKeys.filter((key) => !(key in table));
  const extra = keys.filter((key) => !baseKeys.includes(key));
  if (missing.length || extra.length) {
    errors.push({ locale, missing, extra });
  }

  for (const key of baseKeys) {
    const basePlaceholders = Array.from(String(base[key]).matchAll(placeholderRe), (match) => match[0]).sort().join('|');
    const localePlaceholders = Array.from(String(table[key]).matchAll(placeholderRe), (match) => match[0]).sort().join('|');
    if (basePlaceholders !== localePlaceholders) {
      errors.push({ locale, key, basePlaceholders, localePlaceholders });
    }
  }

  if (locale !== 'en') {
    // 同形词与纯符号先剔掉：它们与英文相同是语言事实，不是漏翻。
    const sameAsEnglish = baseKeys.filter(
      (key) =>
        table[key] === base[key] &&
        !isIntentionallyEnglishKey(key) &&
        !isNonTranslatableValue(base[key])
    );

    const run = longestUntranslatedRun(table);
    const runKeys = run.length ? baseKeys.slice(run.start, run.start + run.length) : [];

    // 主判据：成片的连续相同。8 个相邻键一字不差，几乎不可能是同形巧合。
    const hasUntranslatedBlock = run.length >= 8;
    // 次判据：用比例而非绝对数量，随词表规模自然增长，不必以后再手工调数字。
    const ratioLimit = Math.max(20, Math.floor(baseKeys.length * 0.03));
    const tooManyIdentical = sameAsEnglish.length > ratioLimit;

    if (hasUntranslatedBlock || tooManyIdentical) {
      errors.push({
        locale,
        problem: hasUntranslatedBlock
          ? `untranslated block: ${run.length} consecutive keys are identical to English`
          : 'too many values are identical to English',
        identicalCount: sameAsEnglish.length,
        identicalRatio: `${((sameAsEnglish.length / baseKeys.length) * 100).toFixed(1)}%`,
        identicalLimit: ratioLimit,
        longestRun: run.length,
        longestRunLimit: 8,
        longestRunKeys: runKeys.slice(0, 12),
        identicalSample: sameAsEnglish.slice(0, 25),
      });
    }
  }
}

console.log(JSON.stringify({
  counts: Object.fromEntries(Object.entries(locales).map(([locale, table]) => [locale, Object.keys(table).length])),
  errors,
}, null, 2));

if (errors.length) {
  process.exit(1);
}

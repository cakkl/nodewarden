const fs = require('node:fs');
const path = require('node:path');

const { localeFiles, readLocale } = require('./i18n-utils.cjs');

const distDir = path.resolve(__dirname, '..', 'dist');

fs.mkdirSync(distDir, { recursive: true });

// `dist/404.html` 由 `webapp/public/404.html` 拷来（Vite 会搬运 public 目录）。
// 缺了它，下面的 `/assets/*` 规则会指向不存在的文件 —— 那比不写这条规则更糟。
const notFoundFile = path.join(distDir, '404.html');
if (!fs.existsSync(notFoundFile)) {
  console.error('[pages-spa-redirects] 缺少 dist/404.html，无法安全生成 _redirects');
  process.exit(1);
}

// 404 页文案取自语言包，不在静态 HTML 里维护第二份副本（readLocale 与 i18n-validate 同源）。
const MESSAGE_SLOTS = { title: 'txt_page_not_found', hint: 'txt_page_not_found_hint', home: 'txt_back_to_home' };
const messages = {};
for (const [locale, fileName, variableName] of localeFiles) {
  const table = readLocale(fileName, variableName);
  const entry = {};
  for (const [slot, key] of Object.entries(MESSAGE_SLOTS)) {
    const value = table[key];
    if (typeof value !== 'string' || value === '') {
      console.error(`[pages-spa-redirects] ${fileName} 缺少文案键 ${key}`);
      process.exit(1);
    }
    entry[slot] = value;
  }
  messages[locale] = entry;
}

// `<` 转成 \u003c：防止文案里出现 `</script>` 把 HTML 截断。
// 重复执行也安全 —— 匹配的是标记之间的整段内容，整体替换。
const payload = JSON.stringify(messages).replace(/</g, '\\u003c');
const markerPattern = /(<script type="application\/json" id="nw-not-found-messages">)[\s\S]*?(<\/script>)/;
const notFoundHtml = fs.readFileSync(notFoundFile, 'utf8');
if (!markerPattern.test(notFoundHtml)) {
  console.error('[pages-spa-redirects] dist/404.html 里找不到文案占位标记');
  process.exit(1);
}
fs.writeFileSync(notFoundFile, notFoundHtml.replace(markerPattern, `$1${payload}$2`), 'utf8');

// 规则按顺序匹配、第一条生效，所以 `/assets/*` 必须在 SPA 回退之前。
// 它只对缺失的资源生效（静态文件优先于 `_redirects`）。
fs.writeFileSync(
  path.join(distDir, '_redirects'),
  ['/assets/* /404.html 404', '/* /index.html 200', ''].join('\n')
);

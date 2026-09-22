const fs = require('node:fs');
const path = require('node:path');

const { localeFiles, readLocale } = require('./i18n-utils.cjs');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

// 刻意「读源模板、写 dist」：两条路径不同 ⇒ 既没有「先查存在性再用」的 TOCTOU 窗口
//（CodeQL `js/file-system-race` 曾据此报警），也不依赖 Vite 是否已把 public 目录拷进 dist。
const templateFile = path.join(repoRoot, 'webapp', 'public', '404.html');
const notFoundFile = path.join(distDir, '404.html');

fs.mkdirSync(distDir, { recursive: true });

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
let templateHtml;
try {
  templateHtml = fs.readFileSync(templateFile, 'utf8');
} catch (error) {
  console.error(`[pages-spa-redirects] 读取 404 模板失败：${templateFile}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (!markerPattern.test(templateHtml)) {
  console.error(`[pages-spa-redirects] ${templateFile} 里找不到文案占位标记`);
  process.exit(1);
}
fs.writeFileSync(notFoundFile, templateHtml.replace(markerPattern, `$1${payload}$2`), 'utf8');

// 规则按顺序匹配、第一条生效，所以 `/assets/*` 必须在 SPA 回退之前。
// 它只对缺失的资源生效（静态文件优先于 `_redirects`）。
fs.writeFileSync(
  path.join(distDir, '_redirects'),
  ['/assets/* /404.html 404', '/* /index.html 200', ''].join('\n')
);

const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '..', 'dist');

fs.mkdirSync(distDir, { recursive: true });

// `dist/404.html` 由 `webapp/public/404.html` 拷来（Vite 会搬运 public 目录）。
// 缺了它，下面的 `/assets/*` 规则会指向不存在的文件 —— 那比不写这条规则更糟。
const notFoundFile = path.join(distDir, '404.html');
if (!fs.existsSync(notFoundFile)) {
  console.error('[pages-spa-redirects] 缺少 dist/404.html，无法安全生成 _redirects');
  process.exit(1);
}

// 规则**按顺序匹配、第一条命中的生效**，所以 `/assets/*` 必须写在 SPA 回退之前。
//
// 原因：`/* /index.html 200` 会把不存在的 chunk 也变成 `200 text/html`，
// 浏览器把这段 HTML 当 ES module 解析 ⇒ 语法错误 ⇒ `import()` 失败 ⇒ 内容区整块卸载。
// 真实存在的资源不受影响 —— 静态文件优先于 `_redirects`，规则只对缺失的路径生效。
fs.writeFileSync(
  path.join(distDir, '_redirects'),
  ['/assets/* /404.html 404', '/* /index.html 200', ''].join('\n')
);

// 桌面 PWA（Edge / Chrome）三处约定：标题栏让位、通知横幅下移、重复启动只聚焦。
//
// `display_override` 含 `window-controls-overlay` ⇒ 窗口按钮浮在页面右上角，压住顶栏按钮与
// 通知横幅；避让必须写在打磨层末尾（否则被 `padding-inline` 同特异性压掉）。而
// `navigate-existing` 会导航回 start_url ⇒ 整页重载、内存密钥丢失 ⇒ 每次点图标都要上锁。
// ⚠️ Linux 的 dev server 复现不了 WCO 模式，回归只能靠本护栏发现。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WCO_QUERY = '@media (display-mode: window-controls-overlay)';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 去掉 CSS 注释 —— 否则「注释里提到过的声明」会被判为存在。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取出某个媒体查询块的内容（花括号配对切分）。 */
function mediaBlock(css: string, query: string): { body: string; index: number } {
  const start = css.indexOf(query);
  assert.notEqual(start, -1, `找不到 ${query}（改名了请同步本护栏）`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `${query} 后面没有花括号`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: css.slice(open + 1, i), index: start };
    }
  }
  assert.fail(`${query} 的块没有闭合花括号`);
}

/** 取出块内某条规则的花括号内容。 */
function ruleBody(block: string, selector: string): string {
  const at = block.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `块里找不到 ${selector}（改名了请同步本护栏）`);
  const open = block.indexOf('{', at);
  const close = block.indexOf('}', open);
  assert.ok(close > open, `${selector} 的规则体没有闭合花括号`);
  return block.slice(open + 1, close);
}

const styles = stripComments(readSource('webapp/src/styles.css'));
const wco = mediaBlock(styles, WCO_QUERY);
const manifest = JSON.parse(readSource('webapp/public/manifest.webmanifest')) as {
  display_override?: string[];
  launch_handler?: { client_mode?: string };
};

test('manifest 仍要求 window-controls-overlay（若移除，本护栏与下面的 CSS 一起删）', () => {
  assert.ok(
    manifest.display_override?.includes('window-controls-overlay'),
    'manifest 不再声明 window-controls-overlay：请连同 styles.css 里的 WCO 块与删除本护栏'
  );
});

test('WCO 模式下顶栏右侧必须给窗口控制按钮让位', () => {
  const topbar = ruleBody(wco.body, '.topbar');
  assert.match(
    topbar,
    /padding-right:\s*calc\(100% - env\(titlebar-area-x[^)]*\) - env\(titlebar-area-width[^)]*\)/,
    '顶栏必须用 titlebar-area-* 撑出右侧让位，否则按钮会压住「主题 / 锁定 / 退出」'
  );
});

test('WCO 模式下顶栏是窗口拖动区，且交互元素已挖掉（否则点击被吞）', () => {
  const topbar = ruleBody(wco.body, '.topbar');
  assert.match(topbar, /(^|\s)-webkit-app-region:\s*drag;/, 'WCO 不设 drag 时整个窗口无法用鼠标拖动');
  assert.match(topbar, /(^|\s)app-region:\s*drag;/, '需要标准 `app-region` 与 `-webkit-` 前缀并存');

  for (const selector of ['.topbar a', '.topbar button', '.topbar label', '.topbar input', '.topbar-actions']) {
    assert.ok(wco.body.includes(`${selector},`) || wco.body.includes(`${selector} {`), `拖动区选择器列表里缺 ${selector}`);
  }
  assert.match(wco.body, /-webkit-app-region:\s*no-drag;/, '拖动区里的交互元素缺 `-webkit-app-region: no-drag`');
  assert.match(wco.body, /(^|\s)app-region:\s*no-drag;/, '拖动区里的交互元素缺标准 `app-region: no-drag`');
});

test('WCO 让位规则必须排在打磨层最后（否则被 padding-inline 同特异性压掉）', () => {
  const lastPaddingInline = styles.lastIndexOf('padding-inline');
  assert.notEqual(lastPaddingInline, -1, '样式表里找不到 padding-inline：结构变了，请重新核对本护栏');
  assert.ok(
    wco.index > lastPaddingInline,
    'WCO 块必须位于 styles.css 里最后一条 padding-inline 之后，否则让位宽度会被覆盖掉'
  );
});

test('WCO 模式下通知横幅必须下移到「顶栏 / 标题栏」更高者之下', () => {
  const stack = ruleBody(wco.body, '.toast-stack');
  assert.match(
    stack,
    /top:\s*calc\(max\(56px,\s*env\(titlebar-area-height[^)]*\)\)\s*\+\s*14px\)/,
    '`.toast-stack` 原贴右上角，正好被窗口按钮压住 ⇒ 必须取 max(顶栏 56px, 系统标题栏) 再下移'
  );
});

test('重复启动只聚焦现有窗口，不导航（导航会整页重载 ⇒ 内存密钥丢失 ⇒ 上锁）', () => {
  assert.equal(
    manifest.launch_handler?.client_mode,
    'focus-existing',
    '`navigate-existing` 会把已打开的窗口导航回 start_url，整页重载后密钥（仅内存）丢失 ⇒ 每次点图标都要重新解锁'
  );
});

// 域名规则页的**跨行对齐**护栏（源码文本，无 DOM 依赖）。
//
// `DomainRulesPage` 的展开箭头是按「文本是否溢出」条件渲染的（探针量 `fullWidth > width + 1`），
// 而 `.domain-rule-row` 是 `grid-template-columns: 18px minmax(0,1fr) auto auto`。
// 靠自动放置时：有箭头的行把按钮放进第 4 列，没有箭头的行落进第 3 列、还多让出一个 gap
// ⇒ 同一列表里「一长一短」两行的编辑/删除按钮会错开 10px（实测 657/741 vs 667/750）。
// 所以动作列必须**显式**定位到最后一列。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 取出某条顶层规则的花括号内容；命中前先去掉 CSS 注释 —— 否则「注释掉的声明」也会被判为存在。 */
function cssRuleBody(css: string, selector: string): string {
  // 手工定位（行首锚定 + 花括号切片），不用 `new RegExp(…)` 拼选择器：
  // 既避开 Semgrep detect-non-literal-regexp，也省掉选择器里 `.` 的转义。
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `找不到 ${selector}（改名了请同步本护栏）`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  assert.ok(close > open, `${selector} 的规则体没有闭合花括号`);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('域名规则行：动作列必须显式落在最后一列（否则有无箭头的行会错开一个 gap）', () => {
  const css = readSource('webapp/src/styles/management.css');
  // ⚠️ 用行首锚定 + 去注释：`indexOf('.domain-rule-row-actions {')` 会先命中
  // `.domain-rule-editing-row .domain-rule-row-actions {`；注释里的声明同样不算数。
  assert.match(cssRuleBody(css, '.domain-rule-row-actions'), /grid-column:\s*-1;/, '动作列必须写成 grid-column: -1（最后一列），不能依赖自动放置');

  // 前提：行的列模板是 4 列，第 3 列留给箭头 —— 改成别的形状时本护栏要一起改
  assert.match(
    cssRuleBody(css, '.domain-rule-row'),
    /grid-template-columns:\s*18px minmax\(0,\s*1fr\) auto auto;/,
    '行的列模板变了：箭头列（第 3 列）与动作列（第 4 列）的约定请重新核对'
  );
});

test('域名规则行：箭头仍然只在文本溢出时渲染（它决定按钮列是否被挤开）', () => {
  const page = readSource('webapp/src/components/DomainRulesPage.tsx');
  assert.match(page, /setCanExpand\(fullWidth > width \+ 1\)/, '箭头必须按「是否溢出」决定（否则两种行不会错开）');
  assert.match(page, /\{canExpand && \(/, '箭头渲染条件的形状变了：请同步本护栏');
});

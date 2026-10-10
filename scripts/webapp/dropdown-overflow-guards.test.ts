// 站内自定义下拉的「条目过多」护栏。
// 这些面板都是 `position: absolute` 向下展开的**不限量**列表（项目 / 设备 / 域名 / 标签都
// 可能几十条）：少了封顶会一路顶出屏幕，而界面看上去仍然「能用」。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const vault = readSource('webapp/src/styles/vault.css');
const management = readSource('webapp/src/styles/management.css');

/** 取出某个选择器的规则体（到下一个 `}` 为止）。 */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `找不到规则 ${selector}`);
  const end = css.indexOf('}', at);
  return css.slice(at, end);
}

test('⭐ 通用下拉 `.sort-menu` 必须自己封顶并滚动（条目不限量）', () => {
  const body = ruleBody(vault, '.sort-menu');
  assert.match(body, /max-height: min\(320px, calc\(100dvh - 24px\)\)/, '高度要封顶，并用 dvh 兜住矮视口');
  assert.match(body, /max-width: calc\(100vw - 24px\)/, '长名称撑宽后不能越出屏幕左右边缘');
  assert.match(body, /overflow-y: auto/, '超出上限时要出现滚动条');
  assert.match(body, /overscroll-behavior: contain/, '滚到尽头不该把页面一起带着滚');
});

test('⭐ 各下拉的封顶值不能被「后写的通用规则」提升 —— 顺序即优先级', () => {
  // 三者同为 (0,1,0)，只能靠加载顺序决胜：修饰类的封顶必须写在 `.sort-menu` 之后。
  const sortAt = vault.indexOf('\n.sort-menu {');
  const mobileFilterAt = vault.indexOf('\n.mobile-vault-filter-menu {', sortAt);
  const tagSuggestAt = vault.indexOf('\n.tag-suggest-menu {', sortAt);

  assert.ok(mobileFilterAt > sortAt, '手机筛选菜单的 max-height 要在 `.sort-menu` 之后');
  assert.match(vault.slice(mobileFilterAt, mobileFilterAt + 120), /max-height: 280px/, '手机筛选菜单沿用更矮的 280px');
  assert.ok(tagSuggestAt > sortAt, '标签候选面板的 max-height 要在 `.sort-menu` 之后');
  assert.match(vault.slice(tagSuggestAt, tagSuggestAt + 200), /max-height: 220px/, '标签候选面板沿用 220px');
});

test('⭐ 新增菜单 `.create-menu` 同样要封顶 + 滚动（且不能再 overflow: hidden）', () => {
  const body = ruleBody(management, '.create-menu');
  assert.match(body, /max-height: min\(360px, calc\(100dvh - 24px\)\)/, '上限 360px：当前 8 个条目自然高 335px，卡到 320 会凭白多出滚动条');
  assert.match(body, /overflow-y: auto/, '超出上限时要出现滚动条');
  assert.doesNotMatch(body, /overflow: hidden/, '`overflow: hidden` 会把溢出的条目直接切掉，看不到也滚不到');
});

test('站内自定义浮层就这四类，别漏了任何一个', () => {
  for (const selector of ['.sort-menu', '.create-menu']) {
    assert.ok(vault.includes(selector) || management.includes(selector), `${selector} 应存在`);
  }
  assert.ok(vault.includes('.mobile-vault-filter-menu'), '手筛选菜单复用 .sort-menu + 修饰类');
  assert.ok(vault.includes('.tag-suggest-menu'), '标签候选面板复用 .sort-menu + 修饰类');
});

// 标签输入（`webapp/src/components/TagSuggestInput.tsx`）的源码级护栏。
// 它原用原生 `<datalist>`（下拉由浏览器绘制、CSS 覆盖不了）；下面几点一旦被改回去就会
// 静默退化（界面仍「能用」）。
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

const page = readSource('webapp/src/components/SecretsPage.tsx');
const input = readSource('webapp/src/components/TagSuggestInput.tsx');

test('⭐ 标签字段不得回到原生 `datalist`（它的下拉是浏览器绘制的，样式改不了）', () => {
  // 只看**标签形态**：新写的注释里会提到 datalist（说明为什么不用它），那是允许的
  assert.ok(!/<datalist/i.test(page), 'SecretsPage 里不该再出现 <datalist>');
  assert.ok(!/<datalist/i.test(input), '组件里也不该出现 <datalist>');
  assert.match(page, /<TagSuggestInput/, '标签字段要用自建候选面板的组件');
});

test('⭐ 候选面板必须 preventDefault 掉 mousedown，否则点击永远选不中', () => {
  // 根因：鼠标按下会让输入框先失焦 ⇒ 面板在 click 之前就被关掉，click 落在空气上。
  assert.match(
    input,
    /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/,
    '候选按钮要 preventDefault mousedown（保住焦点），再用 onClick 取值'
  );
  assert.match(input, /onClick=\{\(\) => pick\(tag\)\}/, '取值走 onClick');
});

test('候选面板复用站内下拉的类名（外观与暗色适配随之沿用）', () => {
  assert.match(input, /className="sort-menu tag-suggest-menu"/, '面板用 .sort-menu + 修饰类');
  assert.match(input, /className=\{`sort-menu-item/, '候选项用 .sort-menu-item');
  assert.match(
    readSource('webapp/src/styles/vault.css'),
    /\.tag-suggest-menu\s*\{[\s\S]{0,200}?width: 100%/,
    '修饰类把它铺满输入框宽度（.sort-menu 默认靠右、按内容宽）'
  );
});

test('无障碍：combobox + listbox 的那组属性齐全', () => {
  for (const attr of ['role="combobox"', 'aria-expanded={showList}', 'aria-autocomplete="list"', 'aria-controls=', 'aria-activedescendant=']) {
    assert.ok(input.includes(attr), `输入框缺 ${attr}`);
  }
  assert.match(input, /role="listbox"/, '面板是 listbox');
  assert.match(input, /role="option"/, '候选项是 option');
});

test('候选只由「输入 + 全局标签清单」决定，不引入第二份数据源', () => {
  assert.match(input, /filterTagSuggestions\(props\.options, props\.value\)/, '候选走纯函数');
  assert.match(page, /options=\{manager\.tagOptions\}/, '候选来自 manager 的全局标签清单');
});

test('⭐ 标签字段所在的卡片要抬起来，否则候选面板会被下面的卡片盖住', () => {
  // 根因：`.detail-switch-stage > .card` 的入场动画让每张卡自成层叠上下文 ⇒ 面板的 z-index 出不去。
  assert.match(
    page,
    /projectMenuOpen \|\| manager\.tagOptions\.length > 0 \? 'card-menu-open' : ''/,
    '有标签候选时也要给该卡加 card-menu-open（与项目菜单同一手法）'
  );
});

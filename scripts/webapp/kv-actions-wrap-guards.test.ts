// 「值 + 动作按钮」这一行（`.kv-row` / `.kv-actions`）的排版护栏。
// 第三列是 `auto`、可换行按钮组的 min-content 只是「最宽的那一个按钮」⇒ 行宽 < 382px 时
// 「显示 / 复制」会塔成上下两行（界面仍「能用」，所以要护栏）。
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

const responsive = readSource('webapp/src/styles/responsive.css');
const vault = readSource('webapp/src/styles/vault.css');

/** 取出某个媒体查询的整块内容（含嵌套大括号）。 */
function mediaBlock(css: string, query: string): string {
  const at = css.indexOf(`${query} {`);
  assert.ok(at >= 0, `找不到媒体查询 ${query}`);
  let depth = 0;
  for (let i = at; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`${query} 没有闭合`);
}

test('⭐ ≤1400px 的详情列放不下「值 + 两个带文字的按钮」，动作组必须提前保持一排', () => {
  const block = mediaBlock(responsive, '@media (max-width: 1400px)');
  assert.match(block, /\.kv-actions \{[\s\S]{0,220}?flex-wrap: nowrap/, '动作组不能折行（折行 = 竖排）');
  assert.match(block, /\.kv-actions \.btn\.small \{[\s\S]{0,320}?width: 34px/, '提前切图标形态：两个按钮只要 76px');
});

test('⭐ 图标化必须同时放开值列下限，否则整行会溢出卡片', () => {
  const block = mediaBlock(responsive, '@media (max-width: 1400px)');
  assert.match(
    block,
    /\.kv-row \{[\s\S]{0,220}?grid-template-columns: minmax\(64px, 80px\) minmax\(0, 1fr\) auto/,
    '值列要能一直让位到 0'
  );
});

test('>1400px 的值列下限要留出按钮组的宽度余量', () => {
  // 需求 = 80(标签) + 2×10(gap) + 下限 + 145(两个带文字按钮)；实测该区间最小行宽 370（视口 1401）。
  assert.match(
    vault,
    /grid-template-columns: minmax\(0px, 80px\) minmax\(min\(35%, 110px\), 1fr\) auto/,
    '下限 110px ⇒ 需求 355 < 370，留 15px 余量（原 140px ⇒ 385 > 370，按钮竖排）'
  );
});

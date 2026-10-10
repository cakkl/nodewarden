// 「访问令牌」行内新增栏的手机端排布护栏（`MachineAccountsPage.tsx` + `vault.css`）。
// 四个控件（名称 / 有效期 / 确认 / 取消）不均分就会挤成三行（名称先独占一行），
// 排版看着「能用」但按钮被拆行、右侧留空。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const vault = readFileSync(path.join(REPO_ROOT, 'webapp/src/styles/vault.css'), 'utf8');

/** 取出手机区媒体查询的整块内容。 */
function mobileBlock(): string {
  const at = vault.indexOf('@media (max-width: 640px) {');
  assert.ok(at >= 0, 'vault.css 里应有手机区媒体查询');
  // 找到与之配对的收尾大括号
  let depth = 0;
  for (let i = at; i < vault.length; i += 1) {
    if (vault[i] === '{') depth += 1;
    else if (vault[i] === '}') {
      depth -= 1;
      if (depth === 0) return vault.slice(at, i + 1);
    }
  }
  throw new Error('手机区媒体查询没有闭合');
}

test('⭐ 手机端四个控件各占半行：第一行「名称 + 有效期」，第二行两个按钮', () => {
  const block = mobileBlock();
  for (const part of ['> .input,', '> .input.small,', '> .btn {']) {
    assert.ok(block.includes(`.vault-grid.machine-accounts-grid .machine-inline-row ${part}`), `缺 ${part} 的规则`);
  }
  const body = block.slice(block.indexOf('> .input,'));
  assert.match(body, /flex: 1 1 calc\(50% - 3px\)/, '两两一行要按 50% 减半个 gap 等分（gap 是 6px）');
  assert.match(body, /min-width: 0/, '`.input.small` 的 min-width: 120px 必须让位，否则两列放不下');
  assert.match(body, /width: auto/, '`responsive.css` 的 `.input.small { width: 100% }` 必须被压住');
});

test('手机区规则的特异性要压过后加载的 responsive.css', () => {
  const block = mobileBlock();
  // 选择器至少 4 个类：`.vault-grid.machine-accounts-grid` + `.machine-inline-row` + 目标类
  assert.match(
    block,
    /\.vault-grid\.machine-accounts-grid \.machine-inline-row > \.input\.small/,
    '有效期下拉那条要有 4 个类，才压得住 `.input.small { width: 100% }`'
  );
});

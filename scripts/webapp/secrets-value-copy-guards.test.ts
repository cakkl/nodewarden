// 机密「值」一栏的复制按钮护栏（`webapp/src/components/SecretsPage.tsx`）。
// 值平时是掩码显示的，要拿去用只能先点「显示」再手选文本；密码管理器的密码栏一直是
// 「显示 / 隐藏 + 复制」并列，机密这侧却只有显示。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const page = readFileSync(path.join(REPO_ROOT, 'webapp/src/components/SecretsPage.tsx'), 'utf8');

test('⭐ 详情与回收站的「值」都要有复制按钮，且复制的是值而不是别的字段', () => {
  assert.match(page, /copyTextToClipboard\(selected\.value\)/, '详情页复制的是「值」');
  assert.match(page, /copyTextToClipboard\(trashSelected\.value\)/, '回收站同样（两处形态保持一致）');
});

test('值还没取回来（或为空）时复制按钮要禁用', () => {
  assert.match(page, /disabled=\{manager\.selectedSecretLoading \|\| !selected\.value\}/, '详情页：加载中或空值禁用');
  assert.match(page, /disabled=\{!trashSelected\.value\}/, '回收站：空值禁用');
});

test('复制按钮与「显示」并列在同一个 .kv-actions 里（照密码管理器的密码栏）', () => {
  // `.kv-actions` 里的按钮组是既有布局约定的落点，挪出去会与密码库/机密的其它字段不对齐
  const valueRows = page.match(/<span className="kv-label">\{t\('txt_secret_value'\)\}<\/span>[\s\S]{0,1400}?<\/div>\n              <\/div>/g) ?? [];
  assert.ok(valueRows.length >= 2, `应有 2 处「值」行（详情 + 回收站），实际 ${valueRows.length}`);
  for (const row of valueRows) {
    assert.match(row, /className="kv-actions"/, '复制按钮要放在 .kv-actions 里');
    assert.match(row, /t\('txt_copy'\)/, '按钮文案复用既有键 txt_copy');
  }
});

// 机器账号页（编辑视图）的界面约定 —— 易被改丢、改丢了「看着没错但难用」的那几点：
// ① 两个「新增」按钮在各自卡片的标题行右上角；②「新增项目」按钮**永不消失**（没可加项目就置灰 + 说明）；
// ③ 失效令牌只说明怎么失效的（撤销于 / 过期于）且用文字徽标；④ 新建令牌的表单归「可用」那批，
// 已失效组默认收起且**不持久化**展开状态。
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

const page = readSource('webapp/src/components/MachineAccountsPage.tsx');

test('⭐「新增项目」按钮**永不消失**：没有可加项目时置灰 + 说明，而不是整颗不见', () => {
  // 理由：按钮凭空消失会让人以为这里没有「添加项目」这个功能（而不是「暂时没什么可加」）。
  const picker = page.slice(page.indexOf('function GrantPicker('), page.indexOf('export default function MachineAccountsPage('));
  assert.ok(picker.length > 0, '找不到 GrantPicker（改名了请同步本护栏）');
  assert.ok(
    !/return null;/.test(picker),
    'GrantPicker 不得因候选为空而 return null —— 按钮必须一直在（置灰即可）'
  );
  assert.match(
    picker,
    /disabled=\{props\.disabled \|\| empty\}/,
    '没有候选时要走 disabled（置灰），不能靠不渲染'
  );
  assert.match(picker, /const empty = props\.projects\.length === 0;/, '置灰的判据是候选为空');
  assert.match(picker, /title=\{empty \? props\.emptyReason : undefined\}/, '置灰时要有说明（hover 提示）');
  assert.match(picker, /aria-label=\{empty \? props\.emptyReason : undefined\}/, '置灰时读屏也要能听到原因');

  // 说明分两种：组织里还没项目 / 项目都授权过了 —— 复用既有键 + 一个新增键
  assert.match(page, /projects\.length === 0 \? t\('txt_secret_projects_empty'\) : t\('txt_all_projects_granted'\)/);
});

test('「添加访问令牌」按钮在令牌标题行里，且只有一个', () => {
  const title = '<h4 className="flush-title">{t(\'txt_access_tokens\')}</h4>';
  const titleIndex = page.indexOf(title);
  const addIndex = page.indexOf("setTokenDraft({ name: '', days: 90 })");

  assert.ok(titleIndex > -1, `令牌标题要用 ${title}（配合 .section-head 才排得出标题行）`);
  assert.ok(addIndex > titleIndex, '添加按钮要排在令牌标题**之后**（标题行右侧）');
  assert.ok(addIndex - titleIndex < 600, '添加按钮不要跑回卡片底部（与标题之间不该隔着一整段列表）');
  assert.equal(
    page.match(/setTokenDraft\(\{ name: '', days: 90 \}\)/g)?.length,
    1,
    '添加按钮只能有一个：底部那份要删干净，否则会出现两个入口'
  );
});

test('⭐ 写动作就地打补丁，不再整页重拉', () => {
  // 机器账号的整页重拉是 4 + N 个请求（每个账号各一次令牌）⇒ 写完等它回来会明显卡顿，
  // 与密码库「请求成功后就地更新列表」也不一致。这里钉住页面只走 manager 的补丁接口。
  const manager = readSource('webapp/src/hooks/useMachineAccounts.ts');
  assert.ok(
    !/reload: manager\.onReload/.test(page),
    '走 `run` 的动作自带补丁，不得再把整页重拉挂在包装上'
  );
  for (const patch of ['onUpsertAccount', 'onRemoveAccount', 'onAddToken', 'onReloadAccountTokens']) {
    assert.match(manager, new RegExp(`${patch}:`), `useMachineAccounts 要暴露 ${patch}`);
  }
  assert.match(page, /manager\.onUpsertAccount\(\{/, '保存名称 / 授权后就地更新那一条');
  assert.match(page, /manager\.onAddToken\(activeId, created\.token\)/, '新建令牌直接追加，不等重拉');
  assert.match(page, /manager\.onReloadAccountTokens\(accountId\)/, '撤销令牌只重取那一个账号');
  assert.match(page, /manager\.onRemoveAccount\(target\.id\)/, '删除账号后就地从列表拿掉');
});

test('「添加项目」按钮也在项目标题行里，且不在卡片底部', () => {
  const title = '<h4 className="flush-title">{t(\'nav_secret_projects\')}</h4>';
  const titleIndex = page.indexOf(title);
  const pickerIndex = page.indexOf('<GrantPicker');

  assert.ok(titleIndex > -1, `项目标题要用 ${title}（与令牌那块同一个写法）`);
  assert.ok(pickerIndex > titleIndex, 'GrantPicker 要排在项目标题之后（标题行右侧）');
  assert.equal(page.match(/<GrantPicker/g)?.length, 1, 'GrantPicker 只能有一个：底部那份要删干净');
  assert.ok(
    !/\)\}\}\s*<div className="detail-actions">/.test(page),
    '项目卡片不要再留底部的 detail-actions（按钮已经在标题行里了）'
  );
});

test('⭐ 新建令牌的行内表单归「可用」那批，不掉到已失效组下面', () => {
  const activeIndex = page.indexOf('{accountTokenGroups.active.map(');
  const draftIndex = page.indexOf('{tokenDraftRow}');
  const inactiveIndex = page.indexOf('{renderInactiveTokens(');

  assert.ok(activeIndex > -1 && draftIndex > -1 && inactiveIndex > -1, '三处都该在编辑视图的令牌卡片里');
  assert.ok(
    activeIndex < draftIndex && draftIndex < inactiveIndex,
    '顺序必须是「可用令牌 → 新建表单 → 已失效组」：表单掉到已失效下面会像是给废弃凭据填字段'
  );
});

test('失效令牌只说明「怎么失效的」，状态用文字而不是灰按钮', () => {
  assert.match(page, /txt_revoked_at_value/, '撤销的显示撤销时间');
  assert.match(
    page,
    /txt_expires_at_value', \{ value: day\(token\.expiresAt\) \}/,
    '过期的显示到期时间（复用既有键，不必新增）'
  );
  assert.ok(
    !page.includes('disabled={busy || !!token.revokedAt}'),
    '不要再用「灰掉的撤销按钮」表达状态 —— 改用 list-badge 的文字'
  );
  assert.match(page, /className="list-badge"/, '状态文字用既有的 .list-badge');
  assert.match(
    page,
    /t\('txt_revoked'\)[\s\S]{0,80}t\('txt_expired'\)/,
    '徽标要按原因区分：已撤销 / 已过期'
  );
});

test('⭐ 失效判定含「过期」，且一次渲染只取一个时刻', () => {
  assert.match(page, /txt_inactive_tokens/, '组名是「已失效」（撤销与过期一起收）');
  assert.match(page, /tokenInactiveReason\(token, nowMs\)/, '每行用同一个「现在」判定');
  assert.match(page, /splitTokensByUsable\(\s*\w+,\s*nowMs\s*\)/, '拆分也要用同一个 nowMs');
  assert.equal(
    (page.match(/const nowMs = Date\.now\(\)/g) ?? []).length,
    1,
    '一次渲染只取一次时间：取两次的话边界上的令牌会同时出现在两批里'
  );
});

test('⭐ 已失效组的展开状态不持久化，进出编辑模式即收起', () => {
  assert.ok(
    !/localStorage\.(get|set)Item\(/.test(page),
    '展开状态不要写进 localStorage —— 切页面 / 进出编辑模式要自动收起'
  );
  assert.match(page, /useState\(false\)/, '默认收起（初始状态为 false）');

  const resets = page.match(/setRevokedExpanded\(false\)/g) ?? [];
  // openCreate / openEdit / cancelEdit / 保存成功后退出编辑
  assert.ok(resets.length >= 4, `进入与退出编辑模式都要收起（现在只有 ${resets.length} 处 setRevokedExpanded(false)）`);
});

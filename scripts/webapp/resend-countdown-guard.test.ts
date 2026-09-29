// 发码按钮的倒计时护栏（源码文本抽取，无 DOM 依赖）。
//
// 服务端对发码有 60 秒冷却，文案常量又禁止插值 ⇒ 剩余秒数只能由界面自己数。两个踩过的坑：
// ① 切换验证方式时无条件重发（撞冷却，还可能作废用户刚收到的那枚码）；
// ② 重发按钮在冷却期内仍可点（点了只会报错，而「已发码 / 被限流」的响应刻意一致，看不出来）。
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

/** 取出含指定文案键的 `<button …>` 块（含其后的 1500 字符，足够覆盖 disabled 与 label）。 */
function buttonBlocksWithLabel(source: string, labelKey: string): string[] {
  return source
    .split('<button')
    .slice(1)
    .map((chunk) => chunk.slice(0, 1500))
    .filter((chunk) => chunk.includes(labelKey));
}

/** 断言：这些按钮都受倒计时驱动（禁用条件引用倒计时变量，且文案由 `resendLabel` 拼）。 */
function assertCountdownWired(relativePath: string, labelKey: string, expected: number): void {
  const blocks = buttonBlocksWithLabel(readSource(relativePath), labelKey);
  assert.equal(
    blocks.length,
    expected,
    `${relativePath} 里带 ${labelKey} 的按钮应有 ${expected} 个，实际 ${blocks.length} —— 按钮结构变了，本护栏要跟着改`
  );
  for (const block of blocks) {
    assert.match(block, /disabled=\{[^}]*[Rr]esendIn\b[^}]*\}/s, `${relativePath} 的重发按钮必须按倒计时禁用（否则冷却期内点了只会报错）`);
    assert.match(block, /resendLabel\(/, `${relativePath} 的重发按钮文案必须用 resendLabel 拼出剩余秒数`);
  }
}

test('护栏自检：能定位到重发按钮（抽不到 = 本护栏已失效）', () => {
  const settings = readSource('webapp/src/components/SettingsPage.tsx');
  assert.ok(buttonBlocksWithLabel(settings, "t('txt_mail_send_test')").length > 0, '未能从设置页抽到重发按钮');
});

test('公开 Send 页与设置页的「重新发送」：按倒计时禁用并显示剩余秒数', () => {
  assertCountdownWired('webapp/src/components/PublicSendPage.tsx', "t('txt_email_verification_resend_code')", 1);
  assertCountdownWired('webapp/src/components/SettingsPage.tsx', "t('txt_email_verification_resend_code')", 1);
});

test('管理端「发送测试邮件」：按倒计时禁用并显示剩余秒数', () => {
  assertCountdownWired('webapp/src/components/SettingsPage.tsx', "t('txt_mail_send_test')", 1);
});

test('切换两步验证方式：只在「本轮还没发过码」时补发，绝不无条件重发', () => {
  const source = readSource('webapp/src/App.tsx');
  const start = source.indexOf('function handleSelectTotpProvider(');
  assert.notEqual(start, -1, '找不到 handleSelectTotpProvider：函数改名后请同步本护栏');

  // 取到下一个顶层函数定义为止
  const rest = source.slice(start + 1);
  const nextDef = rest.search(/\n  (?:async )?function /);
  const body = nextDef === -1 ? rest : rest.slice(0, nextDef);

  // 允许补发，但必须被「本轮挑战还没发过码」挡住：无条件重发会撞 60 秒冷却，
  // 且每用户同时只有一枚待用码 ⇒ 重发成功反而让用户刚收到的那枚失效。
  assert.match(
    body,
    /!emailCodeSentRef\.current[\s\S]{0,120}sendEmailTwoFactorCode\(/,
    '切换时的补发必须以 emailCodeSentRef 为条件（默认方式不是邮件时没码可输，需要补发；已发过则不能重发）'
  );
  assert.doesNotMatch(body, /pushToast\(/, '切换 provider 不应产生任何提示（用户只是换了个方式输码）');
});

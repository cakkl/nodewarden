// 邮件渲染偏好的单元测试。
//
// 盯住四件事：
//   ① 语言/时区取自**收件人偏好**（不是全局配置）；
//   ② **未设定**与**值非法**都按未设定处理，并追加**对应那一条**提示句（3 种组合）；
//   ③ 提示句里的 `{timezone}` 必须被真实回退值填掉，不能原样漏到正文里；
//   ④ 时间**不带** `GMT+8` 之类后缀。
//
// 运行方式：npm run test:mail-render-preferences
import assert from 'node:assert/strict';
import test from 'node:test';

import { matchMailLocale, renderVerificationEmail } from '../src/services/mail';
import { resolveMailRenderPreferences } from '../src/services/mail-settings';

/** 2026-09-22 15:45 UTC ⇒ Asia/Shanghai 应为 23:45 */
const EXPIRES = new Date('2026-09-22T15:45:00.000Z');

function renderMail(recipient: { locale?: string | null; timezone?: string | null }) {
  return renderVerificationEmail(
    { code: '123456', expiresAt: EXPIRES },
    resolveMailRenderPreferences(recipient)
  );
}

test('两列都有 ⇒ 用偏好语言/时区，且**不加**任何提示句', () => {
  const mail = renderMail({ locale: 'zh-CN', timezone: 'Asia/Shanghai' });

  assert.match(mail.text, /验证码/, '应当用中文文案');
  assert.match(mail.text, /2026-09-22 23:45/, '时间应按收件人时区（UTC+8）换算');
  assert.doesNotMatch(mail.text, /GMT/, '不应再带 GMT 后缀（需求 7）');
  assert.doesNotMatch(mail.text, /还没有设定/, '设定齐全时不应出现提示句');
});

test('只缺时区 ⇒ 中文提示句 + 时间按 UTC', () => {
  const mail = renderMail({ locale: 'zh-CN', timezone: null });

  assert.match(mail.text, /你还没有设定时区/, '应追加「只缺时区」那一条');
  assert.match(mail.text, /2026-09-22 15:45/, '未设定时区时按 UTC 渲染');
  assert.doesNotMatch(mail.text, /还没有设定语言/, '不应误报语言缺失');
});

test('只缺语言 ⇒ 用默认语言（英文）渲染，并追加英文的「只缺语言」提示句', () => {
  const mail = renderMail({ locale: null, timezone: 'Asia/Shanghai' });

  assert.match(mail.text, /Verification code/, '语言未设定 ⇒ 回退英文');
  assert.match(mail.text, /default language \(English\)/, '应追加「只缺语言」那一条');
  assert.match(mail.text, /2026-09-22 23:45/, '时区仍然生效');
});

test('两个都缺 ⇒ 追加「两个都缺」那一条', () => {
  const mail = renderMail({ locale: null, timezone: null });

  assert.match(mail.text, /you have not set your language or timezone yet/);
  assert.match(mail.text, /2026-09-22 15:45/);
});

test('非法值按「未设定」处理（洞 1：否则会静默回退却不给任何提示）', () => {
  const mail = renderMail({ locale: 'klingon', timezone: 'Not/AZone' });

  // 与「两个都缺」等价：英文 + UTC + 提示句
  assert.match(mail.text, /Verification code/);
  assert.match(mail.text, /2026-09-22 15:45/);
  assert.match(
    mail.text,
    /you have not set your language or timezone yet/,
    '非法迁移值必须被当作「未设定」，否则用户看到英文邮件却没有任何引导'
  );
});

test('提示句里的 {timezone} 占位符必须被真实回退值填掉（洞 2）', () => {
  for (const recipient of [
    { locale: null, timezone: null },
    { locale: null, timezone: 'Not/AZone' },
  ]) {
    const mail = renderMail(recipient);
    assert.doesNotMatch(mail.text, /\{timezone\}/, '占位符漏到正文里了');
    assert.doesNotMatch(mail.html, /\{timezone\}/, 'HTML 路径同样不能漏占位符');
    assert.match(mail.text, /shown in UTC|shows times in UTC/, '应填入实际回退时区');
  }
});

test('HTML 与纯文本两条渲染路径都要带提示句', () => {
  const mail = renderMail({ locale: null, timezone: null });

  assert.match(mail.html, /default language \(English\)/);
  assert.match(mail.text, /default language \(English\)/);
});

test('matchMailLocale：大小写不敏感，未知返回 null', () => {
  assert.equal(matchMailLocale('zh-cn'), 'zh-CN');
  assert.equal(matchMailLocale('ZH-TW'), 'zh-TW');
  assert.equal(matchMailLocale('klingon'), null);
  assert.equal(matchMailLocale(null), null);
  assert.equal(matchMailLocale(''), null);
});

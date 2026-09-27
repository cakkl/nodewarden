import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfigResponse } from '../src/config-response';

test('config enables the official Bitwarden desktop settings dialog', async () => {
  const body = await buildConfigResponse('https://vault.example.test');

  assert.equal(body.featureStates['desktop-ui-settings-dialog'], true);
  assert.equal(body.environment.vault, 'https://vault.example.test');
  assert.equal(body.object, 'config');
});

test('config 不得宣称支持邮箱验证（本服务器没有邮件发送通道）', async () => {
  const body = await buildConfigResponse('https://vault.example.test');

  // 邮件相关端点（/accounts/register/send-verification-email、/accounts/verify-email、
  // /api/two-factor/send-email-login）一律返回 501。若这里报 true，
  // 客户端会展示相应的设置项并调用注定失败的接口。
  assert.equal(body.featureStates['email-verification'], false);
  assert.equal(body.featureStates['pm-19051-send-email-verification'], false);
});

test('config 暴露 mailDeliveryAvailable（前端据此决定主密码提示的说明文案）', async () => {
  // 不传 env ⇒ 拿不到邮件配置 ⇒ 按「不能发信」处理（保守）。
  const body = await buildConfigResponse('https://vault.example.test');
  assert.equal(body.mailDeliveryAvailable, false);
});

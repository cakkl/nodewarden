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

  // 客户端要的是官方那套**邮件链接 / 邮件 OTP** 流程（`/accounts/register/send-verification-email`、
  // `/accounts/verify-email` 等），本服务器仍返回 501（本站的邮箱验证是自有的 6 位码流程）。
  // 若这里报 true，客户端会展示相应入口并调用注定失败的接口。
  assert.equal(body.featureStates['email-verification'], false);
  assert.equal(body.featureStates['pm-19051-send-email-verification'], false);
});

test('config 暴露 mailDeliveryAvailable（前端据此决定主密码提示的说明文案）', async () => {
  // 不传 env ⇒ 拿不到邮件配置 ⇒ 按「不能发信」处理（保守）。
  const body = await buildConfigResponse('https://vault.example.test');
  assert.equal(body.mailDeliveryAvailable, false);
});

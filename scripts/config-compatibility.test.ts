import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfigResponse } from '../src/config-response';

test('config enables the official Bitwarden desktop settings dialog', () => {
  const body = buildConfigResponse('https://vault.example.test');

  assert.equal(body.featureStates['desktop-ui-settings-dialog'], true);
  assert.equal(body.environment.vault, 'https://vault.example.test');
  assert.equal(body.object, 'config');
});

test('config 不得宣称支持邮箱验证（本服务器没有邮件发送通道）', () => {
  const body = buildConfigResponse('https://vault.example.test');

  // 邮件相关端点（/accounts/register/send-verification-email、/accounts/verify-email、
  // /api/two-factor/send-email-login）一律返回 501。若这里报 true，
  // 客户端会展示相应的设置项并调用注定失败的接口。
  assert.equal(body.featureStates['email-verification'], false);
  assert.equal(body.featureStates['pm-19051-send-email-verification'], false);
});

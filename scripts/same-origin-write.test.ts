// 写请求同源判定（CSRF 防护）的行为测试。
//
// 两种模式**边界相反**，改错任一个都有实际后果：
// - 严格（默认）：两个头都没带 ⇒ 拒绝。用于**有意只服务自家前端**的端点（注册）。
//   过宽会让原生客户端/脚本也能注册；这正是要避免的。
// - 宽松：两个头都没带 ⇒ 放行。用于 `password-hint`（官方客户端必须能调）。
//   过宽则会丢掉 CSRF 防护 —— 所以「跨源 Origin 仍被拒绝」必须钉住。
//
// 运行方式：npm test（或 npm run test:same-origin）
import assert from 'node:assert/strict';
import test from 'node:test';

import { isSameOriginWriteRequest } from '../src/utils/origins';

const TARGET = 'https://vault.example/api/accounts/password-hint';

function build(headers: Record<string, string>): Request {
  return new Request(TARGET, { method: 'POST', headers });
}

test('严格模式：同源 Origin ⇒ 放行', () => {
  assert.equal(isSameOriginWriteRequest(build({ Origin: 'https://vault.example' })), true);
});

test('严格模式：跨源 Origin ⇒ 拒绝', () => {
  assert.equal(isSameOriginWriteRequest(build({ Origin: 'https://evil.example' })), false);
});

test('严格模式：只带同源 Referer ⇒ 放行', () => {
  assert.equal(isSameOriginWriteRequest(build({ Referer: 'https://vault.example/login' })), true);
});

test('严格模式：只带跨源 Referer ⇒ 拒绝', () => {
  assert.equal(isSameOriginWriteRequest(build({ Referer: 'https://evil.example/x' })), false);
});

test('严格模式：两个头都没带 ⇒ 拒绝（非浏览器客户端被挡，这是有意的）', () => {
  assert.equal(isSameOriginWriteRequest(build({})), false);
});

test('宽松模式：两个头都没带 ⇒ 放行（原生客户端）', () => {
  assert.equal(isSameOriginWriteRequest(build({}), true), true);
});

test('宽松模式：跨源 Origin **仍** 拒绝（CSRF 防护不丢）', () => {
  assert.equal(isSameOriginWriteRequest(build({ Origin: 'https://evil.example' }), true), false);
});

test('宽松模式：跨源 Referer **仍** 拒绝', () => {
  assert.equal(isSameOriginWriteRequest(build({ Referer: 'https://evil.example/x' }), true), false);
});

test('宽松模式：同源 Origin 照常放行', () => {
  assert.equal(isSameOriginWriteRequest(build({ Origin: 'https://vault.example' }), true), true);
});

test('Origin 为字面量 "null" ⇒ 拒绝（sandbox iframe / file:// 页面）', () => {
  assert.equal(isSameOriginWriteRequest(build({ Origin: 'null' }), true), false);
});

test('Referer 不是合法 URL ⇒ 拒绝', () => {
  assert.equal(isSameOriginWriteRequest(build({ Referer: 'not-a-url' }), true), false);
});

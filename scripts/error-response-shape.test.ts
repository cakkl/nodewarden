// `errorResponse` / `identityErrorResponse` 的响应体形状护栏。
//
// 两个形状对应**两套客户端解析分支**，插错位置 = 消息丢失且**静默**（状态码对、JSON 合法，
// 客户端只读到 `undefined`）。官方客户端的读法：
//   errorModel = (response.ErrorModel && identityResponse) ? response.ErrorModel : response;
//   this.message = getResponseProperty("Message", errorModel);   // 只试 Message/message/MESSAGE
// ⇒ 普通 API 必须把 `Message` 放**顶层**；identity 的嵌套 `ErrorModel.Message` **不能删**
//（客户端还靠它识别「需要新设备验证」）。
//
// 运行方式：npm run test:error-response-shape
import assert from 'node:assert/strict';
import test from 'node:test';

import { errorResponse, identityErrorResponse, tooManyRequestsResponse, unsupportedResponse } from '../src/utils/response';

const MESSAGE = 'Something went wrong';

/** 模拟官方 `BaseResponse.getResponseProperty`：只试三种大小写，不做模糊匹配。 */
function readMessageAsClient(body: Record<string, unknown>, nested = false): unknown {
  const source = nested ? (body.ErrorModel as Record<string, unknown> | undefined) : body;
  if (!source) return undefined;
  for (const key of ['Message', 'message', 'MESSAGE']) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test('普通 API 错误：客户端（非 identity 分支）能读到顶层 Message', async () => {
  const body = await bodyOf(errorResponse(MESSAGE, 400));
  assert.equal(readMessageAsClient(body, false), MESSAGE, '顶层 Message 缺失 ⇒ 官方客户端消息为空');
});

test('普通 API 错误：本站前端读的 error_description 仍然保留', async () => {
  const body = await bodyOf(errorResponse(MESSAGE, 400));
  assert.equal(body.error_description, MESSAGE);
  assert.equal(body.error, MESSAGE);
});

test('普通 API 错误：嵌套 ErrorModel 保留（不破坏既有消费方）', async () => {
  const body = await bodyOf(errorResponse(MESSAGE, 400));
  assert.deepEqual(body.ErrorModel, { Message: MESSAGE, Object: 'error' });
});

test('unsupportedResponse 走同一条路径 ⇒ 501 文案同样可被客户端读到', async () => {
  const response = unsupportedResponse(MESSAGE);
  assert.equal(response.status, 501);
  assert.equal(readMessageAsClient(await bodyOf(response), false), MESSAGE);
});

test('identity 错误：嵌套 ErrorModel 必须保留（客户端走嵌套分支，且靠它识别「需新设备验证」）', async () => {
  const body = await bodyOf(identityErrorResponse(MESSAGE));
  assert.equal(readMessageAsClient(body, true), MESSAGE, 'identity 分支读嵌套 ErrorModel.Message');
  assert.equal((body.ErrorModel as Record<string, unknown>).Object, 'error');
});

// 429 是唯一「正文之外还有信息」的错误：`Retry-After` 决定按钮上倒计时的秒数。
test('限流响应：形状与 errorResponse 一致，并带上 Retry-After（秒）', async () => {
  const response = tooManyRequestsResponse(MESSAGE, 42);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '42');

  const body = await bodyOf(response);
  assert.equal(readMessageAsClient(body, false), MESSAGE, '限流响应同样必须能被客户端读到文案');
  assert.equal(body.error_description, MESSAGE);
  assert.deepEqual(body.ErrorModel, { Message: MESSAGE, Object: 'error' });
});

test('限流响应：剩余秒数一律四舍五入为 ≥ 1 的整数（0 会让客户端认为已可重试）', async () => {
  assert.equal(tooManyRequestsResponse(MESSAGE, 0).headers.get('Retry-After'), '1');
  assert.equal(tooManyRequestsResponse(MESSAGE, 0.2).headers.get('Retry-After'), '1');
  assert.equal(tooManyRequestsResponse(MESSAGE, 59.2).headers.get('Retry-After'), '60');
  assert.equal(tooManyRequestsResponse(MESSAGE, -5).headers.get('Retry-After'), '1');
});

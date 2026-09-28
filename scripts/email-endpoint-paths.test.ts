// 官方客户端路径与「本站自有邮箱验证端点」不得撞车的护栏（router 级）。
//
// 本站的邮箱验证是**自有流程**（6 位数字码），曾把端点挂在官方同名路径上 ——
// 官方 `/accounts/email-token` 是**改邮箱**（给 `newEmail` 发 token），而我们读的是 `email`
// ⇒ 那个检查被跳过 ⇒ **静默给旧地址发了一枚码**（不报错、行为错位）。
// 官方 `/accounts/verify-email` 同理（官方「发链接邮件」vs 我们「提交码」）。
// ⇒ 自有端点已改名为 `/api/accounts/email-verification/{send,confirm}`，官方路径一律 501。
//
// 运行方式：npm run test:email-endpoint-paths
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAuthenticatedRoute } from '../src/router-authenticated';
import type { Env, User } from '../src/types';
import { createSchemaDatabase } from './lib/test-harness';

const USER_ID = 'path-user';
const EMAIL = 'paths@example.test';

async function setup(): Promise<{ env: Env; user: User }> {
  const handle = await createSchemaDatabase();
  const user = {
    id: USER_ID,
    email: EMAIL,
    name: 'Path User',
    emailVerified: false,
    status: 'active',
    role: 'user',
  } as unknown as User;
  return { env: { DB: handle.db } as unknown as Env, user };
}

function post(path: string, body: unknown = {}): Request {
  return new Request(`https://vault.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function dispatch(path: string, body?: unknown): Promise<Response | null> {
  const { env, user } = await setup();
  return handleAuthenticatedRoute(post(path, body), env, USER_ID, user, path, 'POST');
}

/** 官方「改邮箱」的第一步：请求体带 `newEmail`（而不是 `email`）。 */
const OFFICIAL_CHANGE_EMAIL_BODY = { newEmail: 'new@example.test', masterPasswordHash: 'hash' };

test('官方改邮箱路径 ⇒ 501 明确拒绝（不得落到自有的「发码」实现上）', async () => {
  for (const path of ['/api/accounts/email-token', '/accounts/email-token']) {
    const response = await dispatch(path, OFFICIAL_CHANGE_EMAIL_BODY);
    assert.ok(response, `${path} 应当被显式处理（返回响应而非 null/404）`);
    assert.equal(response.status, 501, `${path} 必须 501`);
    const body = (await response.json()) as { error_description?: string };
    assert.match(String(body.error_description), /Changing the email address/i);
  }
});

test('官方改邮箱的第二步 `/accounts/email` ⇒ 同样 501', async () => {
  const response = await dispatch('/api/accounts/email', { newEmail: 'new@example.test', token: 't' });
  assert.ok(response);
  assert.equal(response.status, 501);
});

test('官方 `/accounts/verify-email` ⇒ 501（官方是「发链接邮件」，与我们的「提交码」语义不同）', async () => {
  for (const path of ['/api/accounts/verify-email', '/accounts/verify-email']) {
    const response = await dispatch(path, { code: '123456' });
    assert.ok(response, `${path} 应当被显式处理`);
    assert.equal(response.status, 501, `${path} 必须 501`);
  }
});

test('自有发码端点 `/api/accounts/email-verification/send` 命中路由（不落 404）', async () => {
  const response = await dispatch('/api/accounts/email-verification/send');
  assert.ok(response, '自有发码端点应当被处理，而不是返回 null 交给上层 404');
  // 测试环境没有邮件配置 ⇒ 503；关键是**路由命中了**（既非 null，也非 404/501）
  assert.notEqual(response.status, 501);
  assert.equal(response.status, 503, '未配置发信 ⇒ 503（说明已进入自有 handler）');
});

test('自有确认端点 `/api/accounts/email-verification/confirm` 命中路由', async () => {
  const response = await dispatch('/api/accounts/email-verification/confirm', { code: '123456' });
  assert.ok(response);
  assert.notEqual(response.status, 501);
  assert.equal(response.status, 400, '无待验证的码 ⇒ 400（说明已进入自有 handler）');
});

test('自有路径只接受 POST ⇒ GET 明确 405（不静默）', async () => {
  const { env, user } = await setup();
  const path = '/api/accounts/email-verification/send';
  const get = new Request(`https://vault.example${path}`, { method: 'GET' });
  const response = await handleAuthenticatedRoute(get, env, USER_ID, user, path, 'GET');
  assert.ok(response);
  assert.equal(response.status, 405);
});

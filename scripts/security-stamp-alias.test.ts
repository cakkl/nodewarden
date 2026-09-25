// POST /api/accounts/security-stamp 别名端点的行为测试
//
// 官方客户端的「撤销所有会话」走该路径，本站等价实现是 DELETE /api/devices
// ⇒ 路径不同会让客户端拿到 404。覆盖路由确实命中（而非落到 404），
// 以及校验规则与撤销效果（换 securityStamp、清设备与令牌）。
//
// 运行方式：npm run test:security-stamp-alias
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { handleDeleteAllDevices } from '../src/handlers/devices';
import { handleAuthenticatedRoute } from '../src/router-authenticated';
import { StorageService } from '../src/services/storage';
import type { Env, User } from '../src/types';
import { createD1SqliteDatabase } from './lib/d1-sqlite';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0001_init.sql'), 'utf8');

const USER_ID = 'stamp-user';
const EMAIL = 'stamp@example.com';
const NOW = '2026-01-01T00:00:00.000Z';
// 存「非服务端哈希格式」的旧式行 ⇒ verifyPassword 走常量时间直接比较，
// 于是可以直接传同一个字符串当 masterPasswordHash。
const MASTER_PASSWORD_HASH = 'legacy-client-hash';
const OLD_STAMP = 'stamp-before';

function makeEnv(): Env {
  // `handle.db` 才是交给被测代码当 D1Database 用的对象（同 sync-handler.test.ts）
  const handle = createD1SqliteDatabase();
  handle.connection.exec(SCHEMA_SQL);
  const db = handle.db;
  // 这些列 NOT NULL 且无默认值，必须显式给：
  // master_password_hash / key / kdf_type / kdf_iterations / security_stamp / created_at / updated_at
  db.prepare(
    'INSERT INTO users (id, email, name, master_password_hash, key, kdf_type, kdf_iterations, security_stamp, role, status, verify_devices, created_at, updated_at) ' +
      "VALUES (?,?,?,?,?,?,?,?,'user','active',0,?,?)"
  )
    .bind(USER_ID, EMAIL, 'Stamp User', MASTER_PASSWORD_HASH, 'wrapped-key', 0, 600000, OLD_STAMP, NOW, NOW)
    .run();
  return {
    DB: db,
    // 撤销成功会调 notifyUserLogout；缺绑定虽被吞掉，但会往 stderr 刷错误
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
  } as unknown as Env;
}

function stampRequest(body: unknown): Request {
  return new Request('https://vault.example/api/accounts/security-stamp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readUser(env: Env): Promise<User> {
  const user = await new StorageService(env.DB).getUserById(USER_ID);
  assert.ok(user, '用户应当存在');
  return user;
}

test('别名路由：POST /api/accounts/security-stamp 命中（不落到 404）', async () => {
  const env = makeEnv();
  const user = await readUser(env);

  const response = await handleAuthenticatedRoute(
    stampRequest({ masterPasswordHash: MASTER_PASSWORD_HASH }),
    env,
    USER_ID,
    user,
    '/api/accounts/security-stamp',
    'POST'
  );

  assert.ok(response, '别名路径应当被处理，而不是返回 null 交给上层 404');
  assert.equal(response.status, 200);
});

test('别名路由：其他方法或路径不会被误命中', async () => {
  const env = makeEnv();
  const user = await readUser(env);

  // GET 同路径 ⇒ 不匹配别名（客户端用的是 POST）
  const wrongMethod = await handleAuthenticatedRoute(
    new Request('https://vault.example/api/accounts/security-stamp', { method: 'GET' }),
    env,
    USER_ID,
    user,
    '/api/accounts/security-stamp',
    'GET'
  );
  assert.equal(wrongMethod, null, 'GET 不应命中该端点');

  // 相似但不相同的路径 ⇒ 不应命中
  const wrongPath = await handleAuthenticatedRoute(
    stampRequest({ masterPasswordHash: MASTER_PASSWORD_HASH }),
    env,
    USER_ID,
    user,
    '/api/accounts/security-stamps',
    'POST'
  );
  assert.equal(wrongPath, null, '相似路径不应命中');
});

test('缺少 masterPasswordHash 时拒绝（400），且不改动任何状态', async () => {
  const env = makeEnv();

  for (const body of [{}, { masterPasswordHash: '' }, { masterPasswordHash: '   ' }]) {
    const response = await handleDeleteAllDevices(stampRequest(body), env, USER_ID);
    assert.equal(response.status, 400, `空凭据应被拒绝：${JSON.stringify(body)}`);
  }

  const user = await readUser(env);
  assert.equal(user.securityStamp, OLD_STAMP, '被拒绝时不应更换 securityStamp');
});

test('主密码错误时拒绝（400），且不改动任何状态', async () => {
  const env = makeEnv();
  const response = await handleDeleteAllDevices(
    stampRequest({ masterPasswordHash: 'wrong-password-hash' }),
    env,
    USER_ID
  );

  assert.equal(response.status, 400);
  const user = await readUser(env);
  assert.equal(user.securityStamp, OLD_STAMP, '密码错误时不应更换 securityStamp');
});

test('成功时：更换 securityStamp 并清空设备，返回 success', async () => {
  const env = makeEnv();
  const storage = new StorageService(env.DB);

  // 造一台设备与一个刷新令牌，验证会被一并清掉
  await storage.upsertDevice(USER_ID, 'device-1', 'Test Device', 1, 'session-stamp');
  await storage.saveRefreshToken('refresh-token-value', USER_ID, Date.now() + 60_000, 'device-1');

  const before = await storage.getUserById(USER_ID);
  assert.equal((await storage.getDevicesByUserId(USER_ID)).length, 1, '前置：应有一台设备');

  const response = await handleDeleteAllDevices(
    stampRequest({ masterPasswordHash: MASTER_PASSWORD_HASH }),
    env,
    USER_ID
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.success, true, '响应应当包含 success: true');

  // 客户端对该响应体不做解析（Promise<any>），字段名只作稳定性保证
  assert.ok('removedDevices' in payload, '响应应当报告清掉的设备数');
  assert.equal(payload.removedDevices, 1);

  const after = await storage.getUserById(USER_ID);
  assert.ok(after);
  assert.notEqual(after.securityStamp, before?.securityStamp, 'securityStamp 应当被更换');
  assert.equal((await storage.getDevicesByUserId(USER_ID)).length, 0, '设备应当被清空');
  assert.equal(await storage.getRefreshTokenRecord('refresh-token-value'), null, '刷新令牌应当被清空');
});

// emailVerified / email_verified 返回真实值的测试
//
// 关键约束（查客户端源码确认）：TokenService.getEmailVerified() 读 JWT 的
// `email_verified` claim，**字段缺失或非布尔会抛错**（`No email verification found`）；
// profile 的 `emailVerified` 同样非空必填 ⇒ 两处都必须「始终存在且为布尔」。
//
// 运行方式：npm run test:email-verified
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { Env, User } from '../src/types';
import { createJWT, verifyJWT } from '../src/utils/jwt';
import { buildProfileResponse } from '../src/utils/profile-response';
import { createD1SqliteDatabase } from './lib/d1-sqlite';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0001_init.sql'), 'utf8');

const SECRET = 'test-secret-value-that-is-long-enough-32';

function makeUser(emailVerified: boolean): User {
  return {
    id: 'u1',
    email: 'user@example.com',
    name: 'Test User',
    masterPasswordHint: 'hint',
    masterPasswordHash: 'hash',
    key: 'enc-key',
    privateKey: null,
    publicKey: null,
    kdfType: 0,
    kdfIterations: 600000,
    kdfMemory: null,
    kdfParallelism: null,
    securityStamp: 'stamp',
    role: 'user',
    status: 'active',
    verifyDevices: false,
    totpSecret: null,
    totpRecoveryCode: null,
    yubikeyKey1: null,
    yubikeyKey2: null,
    yubikeyKey3: null,
    yubikeyKey4: null,
    yubikeyKey5: null,
    yubikeyNfc: false,
    apiKey: null,
    emailVerified,
    locale: null,
    autoLocale: false,
    timezone: null,
    autoTimezone: false,
    mailOptIn: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as User;
}

test('profile：服务端无法发信时报「已验证」（避免用户改不掉的横幅）', async () => {
  // 没配 SMTP 时用户**根本完不成**验证 ⇒ 报 false 只会留下一个改不掉的横幅
  //（与设置页「仅当能发信时才显示验证徽标」同一口径）。
  const handle = createD1SqliteDatabase();
  handle.connection.exec(SCHEMA_SQL);
  const env = { DB: handle.db } as unknown as Env;

  // 空配置 ⇒ isMailDeliveryAvailable 为 false ⇒ 报 true
  const unverified = await buildProfileResponse(makeUser(false), env);
  assert.equal(unverified.emailVerified, true, '不能发信时不应报未验证');

  // env 缺省时同样报 true（无法判断 ⇒ 保守，不打扰用户）
  const noEnv = await buildProfileResponse(makeUser(false), undefined);
  assert.equal(noEnv.emailVerified, true, '无 env 时不应报未验证');
});

test('profile：字段始终是布尔（客户端把它标为非空必填）', async () => {
  const response = await buildProfileResponse(makeUser(false), undefined);
  assert.equal(typeof response.emailVerified, 'boolean');
});

test('profile：已验证的用户始终报 true', async () => {
  assert.equal((await buildProfileResponse(makeUser(true), undefined)).emailVerified, true);
});

// 注：「能发信 + 未验证 ⇒ 报 false」需要完整 SMTP 配置，单测构造成本高 ⇒ 留待真机验证。

test('JWT：email_verified 跟随传入的真实值', async () => {
  const token = await createJWT(
    { sub: 'u1', email: 'user@example.com', name: 'Test User', sstamp: 'stamp', email_verified: false },
    SECRET
  );
  const payload = await verifyJWT(token, SECRET);
  assert.ok(payload, 'JWT 应可验证');
  assert.equal(payload.email_verified, false);
});

test('JWT：未传 email_verified 时仍写成布尔 false（缺字段会让客户端抛错）', async () => {
  // 字段缺失会让客户端抛 `No email verification found` ⇒ 必须始终为布尔
  const token = await createJWT(
    { sub: 'u1', email: 'user@example.com', name: 'Test User', sstamp: 'stamp' } as never,
    SECRET
  );
  const payload = await verifyJWT(token, SECRET);
  assert.ok(payload);
  assert.equal(payload.email_verified, false);
  assert.equal(typeof payload.email_verified, 'boolean');
});

test('JWT：值为 true 时保持 true', async () => {
  const token = await createJWT(
    { sub: 'u1', email: 'user@example.com', name: 'Test User', sstamp: 'stamp', email_verified: true },
    SECRET
  );
  const payload = await verifyJWT(token, SECRET);
  assert.equal(payload?.email_verified, true);
});

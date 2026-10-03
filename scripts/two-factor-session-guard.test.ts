// 2FA 配置变更（启停因素 / 增删凭据）**一律不撤销会话**；唯一例外是恢复码紧急通道。
//
// 为什么设护栏：上游原本在 6 个 2FA 入口一律删刷新令牌，而「删令牌」看起来很像安全加固 ⇒ 容易被加回来。
//
// 运行方式：npm run test:two-factor-session
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { handleDisableTwoFactorProvider } from '../src/handlers/accounts';
import { AuthService } from '../src/services/auth';
import type { Env } from '../src/types';
import { TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..', 'src');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

/**
 * 摘出一个具名函数体。
 *
 * 整文件断言不可行：`handlers/accounts.ts` 里改主密码等路径**必须**轮换安全戳并撤会话，
 * 直接对文件搜关键字会把它一起误伤。
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `源码里必须存在 ${name}`);
  const next = source.indexOf('\nexport ', start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

test('源码护栏：2FA 配置变更一律不得撤销会话', () => {
  const accounts = readSource('handlers/accounts.ts');
  const passkeys = readSource('handlers/account-passkeys.ts');

  for (const name of [
    'handleDisableTwoFactorProvider', // 关停验证器 / YubiKey / 通行密钥 2FA
    'handleSetTotpStatus', // 本站前端的验证器开关
    'handlePutTwoFactorAuthenticator', // 官方客户端启用验证器
    'handlePutTwoFactorYubiKey', // 启用 YubiKey
  ]) {
    assert.doesNotMatch(
      functionBody(accounts, name),
      /deleteRefreshTokensByUserId|securityStamp =/,
      `${name} 不得撤销会话 —— 否则用户每动一次 2FA 设置就把所有客户端踢下线`
    );
  }

  for (const name of ['handlePutTwoFactorWebAuthn', 'handleDeleteTwoFactorWebAuthn']) {
    assert.doesNotMatch(
      functionBody(passkeys, name),
      /deleteRefreshTokensByUserId|securityStamp =/,
      `${name} 不得撤销会话（含只删一把凭据的情形）`
    );
  }
});

test('源码护栏：恢复码紧急通道必须撤销会话', () => {
  // 语义与上面相反：凭据全丢时用它开门，且同一步里刚轮换了恢复码
  // ⇒ 旧会话不该带着新凭据继续用。换成「不撤」等于把口子留着。
  const source = readSource('services/two-factor-recovery.ts');
  assert.match(source, /user\.securityStamp = generateUUID\(\)/, '应轮换安全戳（访问令牌一并失效）');
  assert.match(source, /deleteRefreshTokensByUserId\(/, '应删掉刷新令牌');
});

test('行为：关停验证器 2FA 保留既有刷新令牌，但该因素确实被停用', async () => {
  const handle = await createSchemaDatabase();
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const userId = 'aa11bb22-0000-4000-8000-000000000061';
  const userEmail = 'session-guard@example.test';
  const clientHash = 'client-side-hash-of-master-password';

  insertUser(handle.connection, userId, {
    email: userEmail,
    masterPasswordHash: await new AuthService(env).hashPasswordServer(clientHash, userEmail),
  });
  handle.connection
    .prepare('UPDATE users SET totp_secret = ? WHERE id = ?')
    .run('JBSWY3DPEHPK3PXP', userId);
  // 代表「另一台设备」的登录会话
  handle.connection
    .prepare('INSERT INTO refresh_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run('other-device-refresh-token', userId, Date.now() + 3_600_000, Date.now());

  try {
    const response = await handleDisableTwoFactorProvider(
      new Request('https://vault.example.test/api/two-factor/disable', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ type: 0, masterPasswordHash: clientHash }),
      }),
      env,
      userId
    );

    assert.equal(response.status, 200);
    const tokens = handle.connection
      .prepare('SELECT COUNT(*) AS count FROM refresh_tokens WHERE user_id = ?')
      .get(userId) as { count: number };
    assert.equal(tokens.count, 1, '其他设备的刷新令牌必须保留 —— 否则关一次 2FA 就全面掉线');
    const row = handle.connection
      .prepare('SELECT totp_secret AS totp FROM users WHERE id = ?')
      .get(userId) as { totp: string | null };
    assert.equal(row.totp, null, '该因素本身必须真的被停用');
  } finally {
    handle.close();
  }
});

// 恢复码停用两步登录：两条入口**共用同一实现**，且必须停用**全部** provider（含邮件 2FA）。
//
// 为什么盯这一条：恢复码的语义是「无法访问两步登录提供程序时用它停用两步登录」，邮件恰恰是最容易
// 「无法访问」的那个 ⇒ 漏掉它就会陷入「收不到邮件 → 用恢复码 → 邮件 2FA 仍在 → 下次登录又要邮件码」。
// 两条入口历史上各写了一份，于是真的漂移过：后者漏停邮件 2FA。
//
// 运行方式：npm run test:recovery-2fa
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { handleRecoverTwoFactor } from '../src/handlers/accounts';
import { AuthService } from '../src/services/auth';
import type { Env } from '../src/types';
import { TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..', 'src');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

test('源码护栏：两条恢复入口都必须调用同一个实现', () => {
  for (const file of ['handlers/identity.ts', 'handlers/accounts.ts']) {
    assert.match(
      readSource(file),
      /resetTwoFactorByRecoveryCode\(/,
      `${file} 必须复用共享实现 —— 各写一份必然再次漂移`
    );
  }
});

test('源码护栏：共享实现必须停用全部提供程序，并清掉待用码 / 默认偏好 / 会话', () => {
  const source = readSource('services/two-factor-recovery.ts');

  assert.match(source, /user\.totpSecret = null/, '应停用验证器');
  assert.match(source, /user\.yubikeyKey1 = null/, '应停用 YubiKey');
  assert.match(source, /deleteAccountPasskeyCredential\(/, '应删除通行密钥凭据');
  assert.match(source, /twoFactorEmailEnabled = false/, '应停用邮件 2FA');
  assert.match(
    source,
    /user\.twoFactorEmailEnabled = false[\s\S]*reconcileDefaultTwoFactorProvider\(/,
    '内存里的开关也要置 false 且早于 reconcile —— reconcile 按内存字段算「还有哪些提供程序」'
  );
  assert.match(source, /clearChallengeCode\(/, '应清掉待用挑战码（否则已发出的码在有效期内仍能通过校验）');
  assert.match(source, /reconcileDefaultTwoFactorProvider\(/, '全部停用后默认偏好也要清空');
  assert.match(source, /deleteRefreshTokensByUserId\(/, '应删掉刷新令牌');
});

test('行为：/recover-2fa 必须一并停用邮件 2FA，并轮换恢复码、清空默认偏好', async () => {
  const handle = await createSchemaDatabase();
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const userId = '9c3b2a10-0000-4000-8000-000000000001';
  const userEmail = 'recover@example.test';
  const clientHash = 'client-side-hash-of-master-password';
  const oldRecoveryCode = 'RECOVERYCODEABCDEFGH';

  insertUser(handle.connection, userId, {
    email: userEmail,
    masterPasswordHash: await new AuthService(env).hashPasswordServer(clientHash),
  });
  handle.connection
    .prepare(
      'UPDATE users SET totp_secret = ?, totp_recovery_code = ?, two_factor_email_enabled = 1, ' +
        "two_factor_default_provider = 1, email_verified = 1 WHERE id = ?"
    )
    .run('JBSWY3DPEHPK3PXP', oldRecoveryCode, userId);

  try {
    const response = await handleRecoverTwoFactor(
      new Request('https://vault.example.test/identity/accounts/recover-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
        body: JSON.stringify({ email: userEmail, masterPasswordHash: clientHash, recoveryCode: oldRecoveryCode }),
      }),
      env
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { newRecoveryCode?: string };
    const row = handle.connection
      .prepare(
        'SELECT totp_secret AS totp, two_factor_email_enabled AS email, ' +
          'two_factor_default_provider AS def, totp_recovery_code AS code FROM users WHERE id = ?'
      )
      .get(userId) as { totp: string | null; email: number; def: number | null; code: string | null };

    assert.equal(row.totp, null, '应停用验证器');
    assert.equal(row.email, 0, '必须一并停用邮件 2FA（这就是「用恢复码后仍要邮件码」的根因）');
    assert.equal(row.def, null, '全部停用后默认偏好也要清空');
    assert.notEqual(row.code, oldRecoveryCode, '恢复码必须轮换');
    assert.equal(body.newRecoveryCode, row.code, '响应里的新恢复码必须是落库的那一个');
  } finally {
    handle.close();
  }
});

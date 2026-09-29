// 恢复码停用两步登录时，必须把**所有** provider 一并停用（含邮件 2FA）。
//
// 为什么单独测这一条：恢复码的语义是「无法访问两步登录提供程序时用它停用两步登录」，
// 而邮件恰恰是最容易「无法访问」的那个（收不到信 / SMTP 挂了）。漏掉它会让用户陷入
// 「收不到邮件 → 用恢复码 → 邮件 2FA 仍在 → 下次登录又要邮件码」的死循环。
//
// 运行方式：npm run test:email-2fa
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const IDENTITY_PATH = path.resolve(import.meta.dirname, '..', 'src', 'handlers', 'identity.ts');

test('源码护栏：恢复码分支必须停用邮件 2FA 并清掉待用码', () => {
  const source = readFileSync(IDENTITY_PATH, 'utf8');

  // 定位恢复码分支（用 recoveryCodeEquals 作为锚点，它只在该分支出现）
  const anchor = 'recoveryCodeEquals(normalizedTwoFactorToken, user.totpRecoveryCode)';
  const index = source.indexOf(anchor);
  assert.notEqual(index, -1, '找不到恢复码分支：形状变了请同步更新本护栏');

  // 取该分支后续一段（到下一个 else 分支之前）
  const branch = source.slice(index, index + 2000);

  assert.match(
    branch,
    /twoFactorEmailEnabled:\s*false/,
    '恢复码分支必须停用邮件 2FA（否则用户会陷入「收不到邮件 → 用恢复码 → 仍要邮件码」的死循环）'
  );
  assert.match(
    branch,
    /clearChallengeCode\(/,
    '恢复码分支必须清掉待用挑战码（否则已发出的码在有效期内仍能通过校验）'
  );
});

test('源码护栏：恢复码分支必须停用其余三个 provider（防止将来被误删）', () => {
  const source = readFileSync(IDENTITY_PATH, 'utf8');
  const anchor = 'recoveryCodeEquals(normalizedTwoFactorToken, user.totpRecoveryCode)';
  const index = source.indexOf(anchor);
  const branch = source.slice(index, index + 2000);

  assert.match(branch, /user\.totpSecret = null/, '应停用验证器');
  assert.match(branch, /user\.yubikeyKey1 = null/, '应停用 YubiKey');
  assert.match(branch, /deleteAccountPasskeyCredential\(/, '应删除通行密钥凭据');
});

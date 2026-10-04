/**
 * 邮件两步登录（2FA provider 1）的单元测试。
 *
 * 覆盖三层：
 * - 服务层：挑战码生成 / 校验 / 限流窗口 / 与邮箱验证码互不干扰；
 * - handler 层：开关端点（启用前置、主密码校验、停用即作废）；
 * - 登录路径：挑战响应是否列出 provider 1、校验失败是否计入登录失败次数。
 *
 * 发信路径需要 SMTP 握手，由 `mail-smtp-client.test.ts` 的 stub 覆盖，这里不重复。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  RESEND_INTERVAL_MS,
  checkSendQuota,
  clearChallengeCode,
  issueChallengeCode,
  verifyChallengeCode,
} from '../src/services/email-2fa';
import {
  issueVerificationCode,
  verifyEmailCode,
} from '../src/services/email-verification';
import {
  handleDeleteTwoFactorEmail,
  handleGetTwoFactorEmail,
  handlePutTwoFactorEmail,
  handleSendEmailTwoFactorLogin,
} from '../src/handlers/accounts';
import { getUserById, saveUserPreferences, setEmailVerified } from '../src/services/storage-user-repo';
import { saveMailSettings } from '../src/services/mail-settings';
import { AuthService } from '../src/services/auth';
import { handleToken } from '../src/handlers/identity';
import type { Env } from '../src/types';
import {
  getSmtpConnectCalls,
  resetSmtpScript,
  setSmtpScript,
} from './lib/cloudflare-sockets-stub.mjs';
import { TEST_JWT_SECRET, createSchemaDatabase, insertUser, resetProcessScopedStatics } from './lib/test-harness';

const USER_ID = '2f1c2f60-2b54-4d3e-9c11-6a2f7b8d0e02';
const USER_EMAIL = 'twofactor@example.test';
const MASTER_PASSWORD_HASH = 'legacy-client-hash';

async function setup() {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL, masterPasswordHash: MASTER_PASSWORD_HASH });
  const user = await getUserById(handle.db, USER_ID);
  assert.ok(user, '测试用户应能被读出');
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  return { handle, user, env };
}

function jsonRequest(body: unknown): Request {
  return new Request('https://vault.example/api/two-factor/email', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sendEmailLoginRequest(body: unknown): Request {
  return new Request('https://vault.example/api/two-factor/send-email-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────── 服务层 ───────────────────────────

test('发码：写入哈希而非明文，且明文只在返回值里', async () => {
  const { handle } = await setup();
  const issued = await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);
  assert.match(issued.code, /^\d{6}$/, '应是 6 位数字');

  const row = handle.connection
    .prepare('SELECT code_hash FROM two_factor_email_tokens WHERE user_id = ?')
    .get(USER_ID) as { code_hash: string };
  assert.ok(row, '应写入一行');
  assert.notEqual(row.code_hash, issued.code, '库里不能存明文');
  assert.ok(!row.code_hash.includes(issued.code), '哈希里也不该出现明文');
});

test('校验：正确的码通过并立即消费（不能重放）', async () => {
  const { handle } = await setup();
  const issued = await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  assert.equal(await verifyChallengeCode(handle.db, USER_ID, issued.code, TEST_JWT_SECRET), 'ok');
  // 第二次必须失败：码已被消费
  assert.equal(await verifyChallengeCode(handle.db, USER_ID, issued.code, TEST_JWT_SECRET), 'no-code');
});

test('校验：错误的码累加尝试次数，达到上限即作废', async () => {
  const { handle } = await setup();
  const issued = await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i += 1) {
    assert.equal(await verifyChallengeCode(handle.db, USER_ID, '000000', TEST_JWT_SECRET), 'mismatch');
  }
  // 第 MAX_CODE_ATTEMPTS 次失败 ⇒ 直接作废
  assert.equal(await verifyChallengeCode(handle.db, USER_ID, '000000', TEST_JWT_SECRET), 'too-many-attempts');
  // 作废后即使拿正确的码也不行
  assert.equal(await verifyChallengeCode(handle.db, USER_ID, issued.code, TEST_JWT_SECRET), 'no-code');
});

test('校验：过期的码被拒绝并清除', async () => {
  const { handle } = await setup();
  const past = new Date(Date.now() - CODE_TTL_MS - 1000);
  const issued = await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET, past);

  assert.equal(await verifyChallengeCode(handle.db, USER_ID, issued.code, TEST_JWT_SECRET), 'expired');
  const row = handle.connection
    .prepare('SELECT 1 FROM two_factor_email_tokens WHERE user_id = ?')
    .get(USER_ID);
  assert.equal(row, undefined, '过期后应清除该行');
});

test('限流：两次发码之间有最小间隔', async () => {
  const { handle } = await setup();
  await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  const quota = await checkSendQuota(handle.db, USER_ID);
  assert.equal(quota.allowed, false);
  assert.equal(quota.allowed === false && quota.reason, 'too-soon');
  // 剩余秒数供 429 的 `Retry-After` 用；界面靠它在重发按钮上倒计时。
  assert.ok(
    quota.allowed === false && quota.reason === 'too-soon' && quota.retryAfterSeconds > 0
      && quota.retryAfterSeconds <= RESEND_INTERVAL_MS / 1000,
    'too-soon 必须回报 (0, 间隔秒数] 的剩余秒数'
  );

  // 超过间隔后恢复
  const later = new Date(Date.now() + RESEND_INTERVAL_MS + 1000);
  assert.deepEqual(await checkSendQuota(handle.db, USER_ID, later), { allowed: true });
});

test('限流：与邮箱验证的配额互不消耗（两者是独立配额）', async () => {
  const { handle } = await setup();
  // 先用掉邮箱验证的配额
  await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);

  // 邮件 2FA 仍可发码
  const quota = await checkSendQuota(handle.db, USER_ID);
  assert.deepEqual(quota, { allowed: true }, '邮箱验证发过码不该影响 2FA 的配额');
});

test('两张表互不干扰：2FA 的码不会顶掉邮箱验证的码', async () => {
  const { handle } = await setup();
  const verifyCode = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  const challengeCode = await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  // 两个码各自有效
  assert.equal(await verifyEmailCode(handle.db, { id: USER_ID, email: USER_EMAIL }, verifyCode.code, TEST_JWT_SECRET), 'ok');
  assert.equal(await verifyChallengeCode(handle.db, USER_ID, challengeCode.code, TEST_JWT_SECRET), 'ok');
});

test('clearChallengeCode：只清 2FA 的表，不动邮箱验证的码', async () => {
  const { handle } = await setup();
  const verifyCode = await issueVerificationCode(handle.db, USER_ID, USER_EMAIL, TEST_JWT_SECRET);
  await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  await clearChallengeCode(handle.db, USER_ID);

  const remaining = handle.connection
    .prepare('SELECT 1 FROM email_verification_tokens WHERE user_id = ?')
    .get(USER_ID);
  assert.ok(remaining, '邮箱验证的码应仍在');
  assert.equal(await verifyEmailCode(handle.db, { id: USER_ID, email: USER_EMAIL }, verifyCode.code, TEST_JWT_SECRET), 'ok');
});

// ─────────────────────────── handler 层 ───────────────────────────

test('开关端点：未验证邮箱时拒绝启用（400），且不改状态', async () => {
  const { handle, env } = await setup();
  const response = await handlePutTwoFactorEmail(
    jsonRequest({ masterPasswordHash: MASTER_PASSWORD_HASH }),
    env,
    USER_ID
  );

  assert.equal(response.status, 400);
  const user = await getUserById(handle.db, USER_ID);
  assert.equal(user?.twoFactorEmailEnabled, false, '被拒绝时不应改状态');
});

test('开关端点：主密码错误时拒绝（400），且不改状态', async () => {
  const { handle, env } = await setup();
  await saveUserPreferences(handle.db, USER_ID, { twoFactorEmailEnabled: false });

  const response = await handlePutTwoFactorEmail(
    jsonRequest({ masterPasswordHash: 'wrong-hash' }),
    env,
    USER_ID
  );

  assert.equal(response.status, 400);
  const user = await getUserById(handle.db, USER_ID);
  assert.equal(user?.twoFactorEmailEnabled, false);
});

test('开关端点：停用会立即作废待用码', async () => {
  const { handle, env } = await setup();
  await saveUserPreferences(handle.db, USER_ID, { twoFactorEmailEnabled: true });
  const issued = await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  const response = await handleDeleteTwoFactorEmail(
    jsonRequest({ masterPasswordHash: MASTER_PASSWORD_HASH }),
    env,
    USER_ID
  );

  assert.equal(response.status, 200);
  const user = await getUserById(handle.db, USER_ID);
  assert.equal(user?.twoFactorEmailEnabled, false);
  // 已发出的码必须失效
  assert.equal(await verifyChallengeCode(handle.db, USER_ID, issued.code, TEST_JWT_SECRET), 'no-code');
});

// 发码端点是**公开**的（登录前调用）⇒ 限流必须能被客户端读懂：
// 状态码 + `Retry-After`（秒），界面靠它在「重新发送」按钮上倒计时。
test('发码端点：间隔内返回 429 + Retry-After（供按钮倒计时）', async () => {
  const { handle, env } = await setup();
  await saveUserPreferences(handle.db, USER_ID, { twoFactorEmailEnabled: true });
  await setEmailVerified(handle.db, USER_ID, true);
  // 最近刚发过一封信 ⇒ 落在最小间隔内
  await issueChallengeCode(handle.db, USER_ID, TEST_JWT_SECRET);

  const response = await handleSendEmailTwoFactorLogin(
    sendEmailLoginRequest({ email: USER_EMAIL }),
    env
  );

  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get('Retry-After'));
  assert.ok(retryAfter > 0 && retryAfter <= RESEND_INTERVAL_MS / 1000, `Retry-After 应是 (0, ${RESEND_INTERVAL_MS / 1000}] 的秒数，实际 ${retryAfter}`);
  const body = (await response.json()) as Record<string, any>;
  assert.match(String(body.Message), /wait/i, '文案保持英文常量：界面按它映射本地化键');
});

test('发码端点：未启用/未验证邮箱时统一 400（不泄露账号是否存在）', async () => {
  const { env } = await setup();

  const unknown = await handleSendEmailTwoFactorLogin(sendEmailLoginRequest({ email: 'nobody@example.test' }), env);
  const disabled = await handleSendEmailTwoFactorLogin(sendEmailLoginRequest({ email: USER_EMAIL }), env);

  assert.equal(unknown.status, 400);
  assert.equal(disabled.status, 400);
  assert.equal(
    await unknown.text(),
    await disabled.text(),
    '「没这个邮箱」与「没启用」必须逐字相同，否则可以拿来枚举账号'
  );
});

test('状态端点：未验证邮箱时 Available 为 false', async () => {
  const { env } = await setup();
  const response = await handleGetTwoFactorEmail(new Request('https://vault.example/api/two-factor/get-email'), env, USER_ID);

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.Available, false, '未验证邮箱 ⇒ 不可启用');
  // 结构必须与客户端契约一致：外层 `Email` 是对象，内层才是 Enabled / Email。
  assert.equal(typeof body.Email, 'object', '外层 Email 必须是对象（客户端按嵌套结构解析）');
  assert.equal(body.Email.Enabled, false);
  assert.equal(body.Email.Email, USER_EMAIL);
});

// ─────────────────────────── 客户端契约护栏 ───────────────────────────

test('源码护栏：挑战响应必须给邮件 provider 提供 { Email }（否则客户端显示 __$1__）', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const source = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'handlers', 'identity.ts'), 'utf8');

  // 客户端从 `TwoFactorProviders2["1"]` 读邮箱地址来渲染「邮件将发送至 <地址>」：
  //   const data = providers.get(TwoFactorProviderType.Email);
  //   this.twoFactorEmail = data.Email;
  // 给 null 会让占位符原样显示成 `__$1__`（桌面端实测）。
  const anchor = 'provider === String(TWO_FACTOR_PROVIDER_EMAIL)';
  const index = source.indexOf(anchor);
  assert.notEqual(index, -1, '找不到邮件 provider 的 providers2 分支：形状变了请同步更新本护栏');

  const branch = source.slice(index, index + 200);
  assert.match(branch, /Email:/, '邮件 provider 的 providers2 必须含 Email 字段（客户端据此渲染邮箱地址）');
});

// ─────────── 邮件被管理员关闭（`settings.enabled = false`）⇒ 邮箱 2FA 整体下线 ───────────
// 关闭后邮件码根本发不出来：继续要求它等于把「只有邮箱 2FA」的账号锁在登录页。

const CLIENT_HASH = 'client-side-hash-of-master-password';
const LOGIN_CLIENT_IP = '203.0.113.31';

function mailSettingsInput(enabled: boolean) {
  return {
    enabled,
    host: 'smtp.test',
    port: 587,
    encryption: 'starttls' as const,
    username: '',
    fromAddress: 'noreply@example.test',
    fromName: 'NodeWarden',
  };
}

/** 只启用邮箱 2FA 的账号 + 可控的邮件开关（配置写全，只动 `enabled`）。 */
async function setupEmailTwoFactorAccount(mailEnabled: boolean) {
  const handle = await createSchemaDatabase();
  const env = {
    DB: handle.db,
    JWT_SECRET: TEST_JWT_SECRET,
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
  } as unknown as Env;
  await saveMailSettings(env.DB, env, mailSettingsInput(mailEnabled));
  const masterPasswordHash = await new AuthService(env).hashPasswordServer(CLIENT_HASH);
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL, masterPasswordHash });
  await saveUserPreferences(handle.db, USER_ID, { twoFactorEmailEnabled: true });
  await setEmailVerified(handle.db, USER_ID, true);
  return { handle, env };
}

function passwordLoginRequest(): Request {
  return new Request('https://vault.example.test/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': LOGIN_CLIENT_IP },
    body: new URLSearchParams({
      grant_type: 'password',
      username: USER_EMAIL,
      password: CLIENT_HASH,
      scope: 'api offline_access',
      deviceIdentifier: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      deviceName: 'Test Browser',
      deviceType: '14',
    }).toString(),
  });
}

test('登录：邮件开着时仍强制邮箱 2FA（挑战里只有 provider 1）', async () => {
  const h = await setupEmailTwoFactorAccount(true);
  try {
    const response = await handleToken(passwordLoginRequest(), h.env);
    assert.equal(response.status, 400, '开着邮件时两步登录不可省');
    const body = (await response.json()) as Record<string, any>;
    assert.deepEqual(body.TwoFactorProviders, ['1']);
  } finally {
    resetProcessScopedStatics();
    h.handle.close();
  }
});

test('登录：管理员关掉邮件发送后，只启用邮箱 2FA 的账号直接登录（不再要求一个发不出来的因素）', async () => {
  const h = await setupEmailTwoFactorAccount(false);
  try {
    const response = await handleToken(passwordLoginRequest(), h.env);
    assert.equal(response.status, 200, '邮箱 2FA 已不可完成 ⇒ 不能继续要求它，否则用户被锁在门外');
    const body = (await response.json()) as Record<string, any>;
    assert.ok(body.access_token, '应当直接签发 token');
  } finally {
    resetProcessScopedStatics();
    h.handle.close();
  }
});

test('登录发码端点：管理员关掉邮件发送后返回 503，且不发起任何 SMTP 连接', async () => {
  const h = await setupEmailTwoFactorAccount(false);
  setSmtpScript();
  try {
    const response = await handleSendEmailTwoFactorLogin(sendEmailLoginRequest({ email: USER_EMAIL }), h.env);
    assert.equal(response.status, 503, '必须用含 `enabled` 的判定，否则会绕过开关把信发出去');
    assert.equal(getSmtpConnectCalls().length, 0, '发不出信时不该建立 SMTP 连接');
  } finally {
    resetSmtpScript();
    resetProcessScopedStatics();
    h.handle.close();
  }
});

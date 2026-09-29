// 新设备验证（NDV）协议级验收 —— `src/handlers/identity-new-device.ts` 的判定链。
//
// 盯住三类**静默**失效：① 该拦不拦；② 不该发信却发了；③ 逐字文案被改（客户端只认全小写的
// `new device verification required`）。重点是「**未验证邮箱的用户永远收不到信，也永远不被拦**」。
//
// 运行方式：npm run test:new-device
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleSetVerifyDevices } from '../src/handlers/accounts';
import { handleToken } from '../src/handlers/identity';
import { handleResendNewDeviceOtp } from '../src/handlers/identity-new-device';
import { handlePublicRoute } from '../src/router-public';
import { AuthService } from '../src/services/auth';
import { saveMailSettings } from '../src/services/mail-settings';
import { StorageService } from '../src/services/storage';
import { setConfigValue } from '../src/services/storage-config-repo';
import { buildProfileResponse } from '../src/utils/profile-response';
import type { Env } from '../src/types';
import {
  getSmtpConnectCalls,
  getSmtpDataBodies,
  resetSmtpScript,
  setSmtpScript,
} from './lib/cloudflare-sockets-stub.mjs';
import {
  FIXED_NOW,
  TEST_JWT_SECRET,
  createSchemaDatabase,
  insertUser,
  resetProcessScopedStatics,
} from './lib/test-harness';

const USER_ID = 'ndv00000-0000-4000-8000-000000000001';
const USER_EMAIL = 'ndv@example.test';
/** 客户端先哈希一次主密码后发上来的值（服务端再叠一层，见 AuthService） */
const CLIENT_HASH = 'client-side-hash-of-master-password';
const CLIENT_IP = '203.0.113.11';
/** 请求里用的设备标识：默认**不在** devices 表里 ⇒ 陌生设备 */
const NEW_DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
/** 预先插进 devices 表的那台设备 ⇒ 让「该用户已有设备」这一条成立 */
const EXISTING_DEVICE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
/** 又一台陌生设备（既不在 devices 表里，也不是本次请求的标识）—— 用来验「码绑设备」 */
const OTHER_NEW_DEVICE_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const SCHEMA_VERSION_KEY = 'schema.version';
const CURRENT_SCHEMA_VERSION = '2026-09-29-new-device-verification';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  env: Env;
}

interface SetupOptions {
  mailConfigured?: boolean;
  emailVerified?: boolean;
  /** `users.verify_devices`：1 = 开启（生产默认），0 = 用户自己关了 */
  verifyDevices?: number;
  createdAt?: string;
  /** 预置在 devices 表里的设备标识；传 `[]` 表示该用户还没有任何设备 */
  devices?: string[];
  yubikeyKey1?: string;
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const handle = await createSchemaDatabase();
  const env = {
    DB: handle.db,
    // 签发 JWT 需要密钥，否则会报 `DataError: Zero-length key is not supported`
    JWT_SECRET: TEST_JWT_SECRET,
    NOTIFICATIONS_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
  } as unknown as Env;

  if (options.mailConfigured !== false) {
    await saveMailSettings(env.DB, env, {
      enabled: true,
      host: 'smtp.test',
      port: 587,
      encryption: 'starttls',
      username: '',
      fromAddress: 'noreply@example.test',
      fromName: 'NodeWarden',
    });
  }

  const masterPasswordHash = await new AuthService(env).hashPasswordServer(CLIENT_HASH, USER_EMAIL);
  insertUser(handle.connection, USER_ID, {
    email: USER_EMAIL,
    masterPasswordHash,
    createdAt: options.createdAt ?? FIXED_NOW,
    yubikeyKey1: options.yubikeyKey1,
  });
  handle.connection
    .prepare('UPDATE users SET email_verified = ?, verify_devices = ? WHERE id = ?')
    .run(options.emailVerified === false ? 0 : 1, options.verifyDevices ?? 1, USER_ID);

  for (const deviceIdentifier of options.devices ?? [EXISTING_DEVICE_ID]) {
    seedDevice(handle.connection, deviceIdentifier);
  }
  return { handle, env };
}

function seedDevice(connection: DatabaseSync, deviceIdentifier: string): void {
  connection
    .prepare(
      'INSERT INTO devices (user_id, device_identifier, name, type, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    )
    .run(USER_ID, deviceIdentifier, 'Existing device', 14, FIXED_NOW, FIXED_NOW);
}

function countOtps(h: Harness): number {
  const row = h.handle.connection
    .prepare('SELECT COUNT(*) AS total FROM new_device_otps WHERE user_id = ?')
    .get(USER_ID) as { total: number };
  return row.total;
}

function readVerifyDevices(h: Harness): number {
  const row = h.handle.connection
    .prepare('SELECT verify_devices AS value FROM users WHERE id = ?')
    .get(USER_ID) as { value: number };
  return row.value;
}

function readSchemaVersion(h: Harness): string | null {
  const row = h.handle.connection
    .prepare('SELECT value FROM config WHERE key = ?')
    .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * 切全局开关。**直接写库**（没有管理端入口）⇒ 这里断言的就是运维契约：
 * `config` 里 `globalSettings__security__newDeviceVerification` 置 '0' 即回退，键不存在视为开。
 */
async function setGlobalSwitch(h: Harness, enabled: boolean): Promise<void> {
  await setConfigValue(h.env.DB, 'globalSettings__security__newDeviceVerification', enabled ? '1' : '0');
}

/** 读 NDV 的**有效值**。官方客户端也这么读（profile 的 `VerifyDevices`）—— 没有 settings 读取端点。 */
async function readEffectiveVerifyDevices(h: Harness): Promise<boolean> {
  const user = await new StorageService(h.env.DB).getUserById(USER_ID);
  assert.ok(user, '前置条件：用户应当存在');
  return (await buildProfileResponse(user!, h.env)).verifyDevices === true;
}

/** 密码授权的登录请求；`payload` 用来带 `newDeviceOtp` 或换设备标识。 */
function loginRequest(payload: Record<string, string> = {}): Request {
  return new Request('https://vault.example.test/identity/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': CLIENT_IP },
    body: new URLSearchParams({
      grant_type: 'password',
      username: USER_EMAIL,
      password: CLIENT_HASH,
      scope: 'api offline_access',
      deviceIdentifier: NEW_DEVICE_ID,
      deviceName: 'Test Browser',
      deviceType: '14',
      ...payload,
    }).toString(),
  });
}

async function login(
  h: Harness,
  payload: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleToken(loginRequest(payload), h.env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function resendRequest(
  body: Record<string, unknown>,
  options: { deviceIdentifier?: string | null; origin?: string | null; path?: string } = {}
): Request {
  const deviceIdentifier = options.deviceIdentifier === undefined ? NEW_DEVICE_ID : options.deviceIdentifier;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deviceIdentifier) headers['Device-Identifier'] = deviceIdentifier;
  if (options.origin) headers.Origin = options.origin;
  return new Request(`https://vault.example.test${options.path ?? '/accounts/resend-new-device-otp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function resend(
  h: Harness,
  body: Record<string, unknown>,
  deviceIdentifier: string | null = NEW_DEVICE_ID
): Promise<{ status: number; raw: string }> {
  const response = await handleResendNewDeviceOtp(resendRequest(body, { deviceIdentifier }), h.env);
  return { status: response.status, raw: await response.text() };
}

async function resendViaRouter(h: Harness, options: Parameters<typeof resendRequest>[1] = {}): Promise<Response | null> {
  return handlePublicRoute(
    resendRequest({ email: USER_EMAIL, masterPasswordHash: CLIENT_HASH }, options),
    h.env,
    options.path ?? '/accounts/resend-new-device-otp',
    'POST',
    async () => null
  );
}

/** 从投递出去的邮件里取回 6 位验证码（正文是 base64 分段编码，见 `buildMimeMessage`）。 */
function lastDeliveredCode(): string {
  const parts: string[] = [];
  let payload: string[] = [];
  let inBody = false;
  const flush = (): void => {
    if (!payload.length) return;
    parts.push(Buffer.from(payload.join(''), 'base64').toString('utf8'));
    payload = [];
  };
  for (const line of getSmtpDataBodies().join('\r\n').split('\r\n')) {
    if (line.startsWith('--nw-')) {
      flush();
      inBody = false;
      continue;
    }
    if (line.startsWith('Content-Transfer-Encoding:')) {
      inBody = true;
      continue;
    }
    if (inBody && line !== '') payload.push(line);
  }
  flush();
  const match = parts.join('\n').match(/\b(\d{6})\b/);
  assert.ok(match, '邮件正文里应当能找到 6 位验证码');
  return match![1];
}

// ---------------------------------------------------------------- 挑战与逐字文案

test('陌生设备：400 挑战 + 文案逐字 + 发出一封码', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const { status, body } = await login(h);

    assert.equal(status, 400);
    // 客户端据此进入输码页 ⇒ 大小写与句点都不能动
    assert.deepStrictEqual(body.ErrorModel, { Message: 'new device verification required', Object: 'error' });
    assert.equal(body.error_description, 'New device verification required');
    assert.equal(getSmtpConnectCalls().length, 1, '挑战应当在同一次请求里把码发出去');
    assert.equal(countOtps(h), 1, '应当留下一枚（用户, 设备）绑定的待用码');
    assert.equal(h.handle.connection.prepare('SELECT device_identifier FROM new_device_otps').get()!.device_identifier, NEW_DEVICE_ID);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('带正确验证码重登：200 + 签发凭据 + 码被消费', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    await login(h);
    const code = lastDeliveredCode();

    const retry = await login(h, { newDeviceOtp: code });
    assert.equal(retry.status, 200);
    assert.ok(retry.body.access_token, '输对码应当签出 access_token');
    assert.equal(countOtps(h), 0, '码必须一次性消费掉（库里不能再留）');

    // 同一枚码换一台**陌生**设备重放 ⇒ 绑定关系把它拦下（码里混了 device_identifier）
    const crossDevice = await login(h, { deviceIdentifier: OTHER_NEW_DEVICE_ID, newDeviceOtp: code });
    assert.equal(crossDevice.status, 400);
    assert.equal(crossDevice.body.error_description, 'Invalid New Device OTP');
    assert.equal(getSmtpConnectCalls().length, 1, '失败路径绝不能补发');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('错误验证码：400 同一文案；错满 5 次即作废，正确的码也不再可用', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    await login(h);
    const code = lastDeliveredCode();
    const wrongCode = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { status, body } = await login(h, { newDeviceOtp: wrongCode });
      assert.equal(status, 400, `第 ${attempt} 次错码应当 400`);
      assert.equal(body.error_description, 'Invalid New Device OTP');
    }
    assert.equal(countOtps(h), 0, '第 5 次错码后应把码清掉');
    assert.equal((await login(h, { newDeviceOtp: code })).status, 400, '作废后即使码正确也不能通过');
    assert.equal(getSmtpConnectCalls().length, 1, '猜码不产生任何新邮件');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 放行分支（都不能发信）

test('已知设备：直接 200，不发信', async () => {
  const h = await setup({ devices: [NEW_DEVICE_ID] });
  setSmtpScript();
  try {
    const { status } = await login(h);
    assert.equal(status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
    assert.equal(countOtps(h), 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('用户自己关了该功能：直接 200，不发信', async () => {
  const h = await setup({ verifyDevices: 0 });
  setSmtpScript();
  try {
    assert.equal((await login(h)).status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('账号创建不足 24 小时：直接 200，不发信', async () => {
  const h = await setup({ createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  setSmtpScript();
  try {
    assert.equal((await login(h)).status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('该用户还没有任何设备（首次登录）：直接 200，不发信', async () => {
  const h = await setup({ devices: [] });
  setSmtpScript();
  try {
    assert.equal((await login(h)).status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('已开 2FA 的用户：走 2FA 挑战，不叠加新设备验证', async () => {
  const h = await setup({ yubikeyKey1: 'yubikey-public-id' });
  setSmtpScript();
  try {
    const { status, body } = await login(h);
    assert.equal(status, 400);
    assert.ok(body.TwoFactorProviders, '应当是 2FA 挑战');
    const errorModel = body.ErrorModel as { Message?: string } | undefined;
    assert.notEqual(errorModel?.Message, 'new device verification required', '不能同时是新设备验证挑战');
    assert.equal(errorModel?.Message, 'Two factor required.');
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('60 秒内重复触发：响应不变，且不发第二封', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const first = await login(h);
    const second = await login(h);

    assert.equal(second.status, first.status);
    assert.deepStrictEqual(second.body, first.body, '「被限流」不能成为「设备是否已验证」的判据');
    assert.equal(getSmtpConnectCalls().length, 1, '限流命中必须静默不发信');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('全局开关关闭：行为回退到旧路径（200，不发信）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    await setGlobalSwitch(h, false);
    assert.equal((await login(h)).status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮箱未验证：放行 + 零发信 + 零待用码（即使带着垃圾码）', async () => {
  const h = await setup({ emailVerified: false });
  setSmtpScript();
  try {
    assert.equal((await login(h)).status, 200, '不想验证邮箱的用户不能被锁在门外');
    assert.equal(getSmtpConnectCalls().length, 0, '一封都不能发');
    assert.equal(countOtps(h), 0, '不该留下任何待用码');

    assert.equal((await login(h, { newDeviceOtp: '000000' })).status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('邮件配置被停用：放行 + 零发信（不会把用户锁在门外）', async () => {
  const h = await setup({ mailConfigured: false });
  setSmtpScript();
  try {
    assert.equal((await login(h)).status, 200);
    assert.equal(getSmtpConnectCalls().length, 0);
    assert.equal(countOtps(h), 0);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 重新发送端点

test('重新发送：成功才发信；其余情况响应逐字一致且不发信（防枚举）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const ok = await resend(h, { email: USER_EMAIL, masterPasswordHash: CLIENT_HASH });
    assert.equal(ok.status, 200);
    assert.equal(getSmtpConnectCalls().length, 1, '主密码正确 + 邮箱已验证 ⇒ 应当发码');
    assert.equal(countOtps(h), 1);

    const unknownUser = await resend(h, { email: 'nobody@example.test', masterPasswordHash: CLIENT_HASH });
    const wrongPassword = await resend(h, { email: USER_EMAIL, masterPasswordHash: 'wrong-hash' });
    const tooSoon = await resend(h, { email: USER_EMAIL, masterPasswordHash: CLIENT_HASH });
    for (const [label, result] of [['邮箱不存在', unknownUser], ['密码错误', wrongPassword], ['60 秒内重发', tooSoon]] as const) {
      assert.equal(result.status, ok.status, `${label}：状态码必须一致`);
      assert.equal(result.raw, ok.raw, `${label}：响应体必须逐字一致`);
    }
    assert.equal(getSmtpConnectCalls().length, 1, '上面三种情况都不该发信');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('重新发送：未验证邮箱 / 该功能已关 ⇒ 同样一致，不发信', async () => {
  const unverified = await setup({ emailVerified: false });
  const disabled = await setup({ verifyDevices: 0 });
  setSmtpScript();
  try {
    for (const h of [unverified, disabled]) {
      const result = await resend(h, { email: USER_EMAIL, masterPasswordHash: CLIENT_HASH });
      assert.equal(result.status, 200);
      assert.equal(countOtps(h), 0);
    }
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
    unverified.handle.close();
    disabled.handle.close();
  }
});

// ---------------------------------------------------------------- 路由级（直调 handler 测不到这一层）

test('路由级：重发端点命中真实 handler，而不是 501 桩', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const response = await resendViaRouter(h);
    assert.ok(response, '路由必须命中 —— 返回 null 就等于 404');
    // 踩过的坑：该路径一度**同时**留在 `publicMailBackedPaths` 里 ⇒ 界面提示
    // 「Email link and email OTP flows are not implemented by this server.」
    assert.notEqual(response.status, 501, '不得被 501 桩拦下');
    assert.equal(response.status, 200);
    assert.equal(getSmtpConnectCalls().length, 1);

    const alias = await resendViaRouter(h, { path: '/api/accounts/resend-new-device-otp' });
    assert.equal(alias?.status, 200, '`/api` 别名同样要命中');
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('路由级：官方桌面带自己的 Origin 时也必须放行（否则官方「重新发送」会 403）', async () => {
  const h = await setup();
  setSmtpScript();
  try {
    const official = await resendViaRouter(h, { origin: 'bw-desktop-file://bundle' });
    assert.equal(official?.status, 200, '官方桌面会带自己的 Origin ⇒ 端点不能做严格同源比较');
    assert.equal(getSmtpConnectCalls().length, 1);
  } finally {
    resetSmtpScript();
    h.handle.close();
  }
});

test('路由级：同一桩列表里的其它路径仍必须 501（别顺手把桩列表删了）', async () => {
  const h = await setup();
  try {
    const stubbed = await handlePublicRoute(
      new Request('https://vault.example.test/accounts/register/finish', { method: 'POST' }),
      h.env,
      '/accounts/register/finish',
      'POST',
      async () => null
    );
    assert.equal(stubbed?.status, 501, '官方「注册收尾」路径仍应明确 501');
  } finally {
    h.handle.close();
  }
});

// ---------------------------------------------------------------- profile 与设置端点

test('profile：verifyDevices 报「有效值」而不是库里的原始值', async () => {
  const h = await setup();
  try {
    assert.equal(await readEffectiveVerifyDevices(h), true);

    await setGlobalSwitch(h, false);
    assert.equal(await readEffectiveVerifyDevices(h), false, '全局开关关着 ⇒ 该项不生效');

    await setGlobalSwitch(h, true);
    h.handle.connection.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(USER_ID);
    assert.equal(await readEffectiveVerifyDevices(h), false, '未验证邮箱 ⇒ 该项不生效');
  } finally {
    h.handle.close();
  }
});

test('设置端点：写 → 落库 → profile 反映，并留下审计', async () => {
  const h = await setup();
  try {
    assert.equal(await readEffectiveVerifyDevices(h), true);

    const write = await handleSetVerifyDevices(
      new Request('https://vault.example.test/accounts/verify-devices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifyDevices: false, masterPasswordHash: CLIENT_HASH }),
      }),
      h.env,
      USER_ID
    );
    assert.equal(write.status, 200);
    assert.equal(((await write.json()) as Record<string, unknown>).verifyDevices, false);
    assert.equal(readVerifyDevices(h), 0, '设置必须真的落库');
    assert.equal(await readEffectiveVerifyDevices(h), false, 'profile 必须跟着变');

    const audit = h.handle.connection
      .prepare("SELECT action, level FROM audit_logs WHERE action = 'account.verify_devices.update'")
      .get() as { action: string; level: string } | undefined;
    assert.equal(audit?.action, 'account.verify_devices.update');
    assert.equal(audit?.level, 'security');
  } finally {
    h.handle.close();
  }
});

test('设置端点：未验证邮箱时不允许开启（开了也收不到码）', async () => {
  const h = await setup({ emailVerified: false });
  try {
    const write = await handleSetVerifyDevices(
      new Request('https://vault.example.test/accounts/verify-devices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifyDevices: true, masterPasswordHash: CLIENT_HASH }),
      }),
      h.env,
      USER_ID
    );
    assert.equal(write.status, 400);
    assert.equal(readVerifyDevices(h), 1, '接口应当拒绝，而不是悄悄把库改坏');
  } finally {
    h.handle.close();
  }
});

// ---------------------------------------------------------------- 迁移

test('迁移：老库升级时把 verify_devices 翻转一次，且**不覆盖**用户之后的选择', async () => {
  const h = await setup();
  try {
    // 模拟老库：版本号还是旧的，且有用户仍是「默认关闭」的状态
    h.handle.connection
      .prepare('UPDATE config SET value = ? WHERE key = ?')
      .run('2026-01-01-legacy', SCHEMA_VERSION_KEY);
    h.handle.connection.prepare('UPDATE users SET verify_devices = 0 WHERE id = ?').run(USER_ID);

    resetProcessScopedStatics();
    await new StorageService(h.env.DB).initializeDatabase();
    assert.equal(readVerifyDevices(h), 1, '老库应当被一次性翻转为「默认开启」');
    assert.equal(readSchemaVersion(h), CURRENT_SCHEMA_VERSION);

    // 第二次升级：用户自己关掉的必须保持关闭（靠 schema.version 当标记，天然幂等）
    h.handle.connection.prepare('UPDATE users SET verify_devices = 0 WHERE id = ?').run(USER_ID);
    // 删掉必需表 ⇒ 强制再跑一遍完整 schema（否则 gate 会跳过，断言就成了空转）
    h.handle.connection.exec('DROP TABLE new_device_otps');
    resetProcessScopedStatics();
    await new StorageService(h.env.DB).initializeDatabase();

    assert.equal(readVerifyDevices(h), 0, '不能盖掉用户自己的选择');
    const table = h.handle.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'new_device_otps'")
      .get() as { name: string } | undefined;
    assert.ok(table, 'new_device_otps 应当被重新建出来');
  } finally {
    h.handle.close();
  }
});

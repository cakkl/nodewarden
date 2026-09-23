/**
 * 安全通知邮件的行为验收：盯的是**静默失效** —— 该发时一封不发、或开关关着却照样发。
 * 两者都不报错，只能靠断言钉住。运行方式：`npm run test:security-notifications`
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleGetTotpRecoveryCode } from '../src/handlers/accounts';
import { AuthService } from '../src/services/auth';
import type { AuditEventInput } from '../src/services/audit-events';
import { renderNotificationEmail } from '../src/services/mail';
import { saveMailSettings } from '../src/services/mail-settings';
import { auditAndNotify, notificationRecipientSnapshot } from '../src/services/security-notifications';
import { StorageService } from '../src/services/storage';
import type { Env } from '../src/types';
import {
  getSmtpCommands,
  getSmtpConnectCalls,
  getSmtpDataBodies,
  resetSmtpScript,
  setSmtpScript,
} from './lib/cloudflare-sockets-stub.mjs';
import { TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const USER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const USER_EMAIL = 'notify@example.test';
/** 管理员操作**他人**账户时的操作者：收件人应当是目标用户，而不是这个管理员 */
const ADMIN_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

interface SetupOptions {
  /** 用户级开关 `users.mail_opt_in`；缺省为关，与库里的默认值一致 */
  optIn?: boolean;
  /** `users.email_verified` */
  verified?: boolean;
  /** 全局发信能力（SMTP 已配置且 enabled）；缺省为可用 */
  mailConfigured?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL });
  insertUser(handle.connection, ADMIN_ID, { email: 'admin@example.test', role: 'admin' });
  handle.connection
    .prepare('UPDATE users SET mail_opt_in = ?, email_verified = ? WHERE id = ?')
    .run(options.optIn ? 1 : 0, options.verified ? 1 : 0, USER_ID);

  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  if (options.mailConfigured !== false) {
    await saveMailSettings(env.DB, env, {
      enabled: true,
      host: 'smtp.test',
      port: 587,
      // 这个值会被直接写进 config.value，给 undefined 会撞上 NOT NULL
      encryption: 'starttls',
      username: '',
      fromAddress: 'noreply@example.test',
      fromName: 'NodeWarden',
    });
  }
  return { handle, env };
}

/** `waitUntil` 在测试桩里是「立即执行但不返回 promise」，所以只能轮询等它跑完。 */
async function waitForSmtp(expected: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && getSmtpConnectCalls().length < expected) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 「不该发」的用例没有条件可等，给一小段固定窗口。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/**
 * 还原最近一封邮件的正文。
 *
 * 正文是 base64 编码的（见 `buildMimeMessage`），所以要逐段解码 ——
 * 不能把两段拼在一起解，各段长度未必都是 4 的倍数。
 */
function decodeMimeBodies(): string {
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
  return parts.join('\n');
}

async function waitForAudit(connection: DatabaseSync, action: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = connection.prepare('SELECT 1 FROM audit_logs WHERE action = ?').get(action);
    if (row) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function changePasswordEvent(): AuditEventInput {
  return {
    actorUserId: USER_ID,
    action: 'user.password.change',
    category: 'security',
    level: 'security',
    metadata: { ip: '203.0.113.7' },
  };
}

function adminStatusEvent(status: 'banned' | 'active'): AuditEventInput {
  return {
    actorUserId: ADMIN_ID,
    action: 'admin.user.status',
    category: 'security',
    level: 'security',
    targetType: 'user',
    targetId: USER_ID,
    metadata: { status },
  };
}

function loginEvent(metadata: Record<string, unknown> = {}): AuditEventInput {
  return {
    actorUserId: USER_ID,
    action: 'auth.login.success',
    category: 'auth',
    level: 'info',
    targetType: 'user',
    targetId: USER_ID,
    metadata: { country: 'JP', deviceName: 'iPhone 15', deviceType: 1, ...metadata },
  };
}

function countriesKey(): string {
  return `securityNotify__countries__${USER_ID}`;
}

async function readCountries(storage: StorageService): Promise<string[]> {
  return JSON.parse((await storage.getConfigValue(countriesKey())) ?? '[]') as string[];
}

// ------------------------------------------------------------ 应当发信

test('开关开启且邮箱已验证：关键操作会真的发出通知', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  setSmtpScript();
  try {
    await auditAndNotify(env, changePasswordEvent());
    await waitForSmtp(1);
    assert.equal(getSmtpConnectCalls().length, 1, '应当发起一次 SMTP 连接');
    const commands = getSmtpCommands();
    assert.ok(commands.some((command) => command.startsWith('RCPT TO:')), '应当指定收件人');
    assert.ok(commands.includes('DATA'), '应当进入正文投递阶段');
  } finally {
    resetSmtpScript();
  }
});

test('管理员禁用账户会通知，恢复启用则不会', async () => {
  const banned = await setup({ optIn: true, verified: true });
  setSmtpScript();
  try {
    await auditAndNotify(banned.env, adminStatusEvent('banned'));
    await waitForSmtp(1);
    assert.equal(getSmtpConnectCalls().length, 1, '禁用账户属于风险事件');
  } finally {
    resetSmtpScript();
  }

  const active = await setup({ optIn: true, verified: true });
  setSmtpScript();
  try {
    await auditAndNotify(active.env, adminStatusEvent('active'));
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0, '恢复访问不是风险，不该打扰用户');
  } finally {
    resetSmtpScript();
  }
});

test('账户已被删除：改用删除前写进元数据的收件人快照', async () => {
  const { handle, env } = await setup({ optIn: true, verified: true });
  // 删除用户，模拟「通知时用户行已经查不到」
  handle.connection.prepare('DELETE FROM users WHERE id = ?').run(USER_ID);
  setSmtpScript();
  try {
    await auditAndNotify(env, {
      actorUserId: ADMIN_ID,
      action: 'admin.user.delete',
      category: 'security',
      level: 'security',
      targetType: 'user',
      targetId: USER_ID,
      metadata: notificationRecipientSnapshot({ email: USER_EMAIL, mailOptIn: true, emailVerified: true }),
    });
    await waitForSmtp(1);
    assert.equal(getSmtpConnectCalls().length, 1, '删除是最需要通知的事件，不能因为查不到用户就跳过');
    assert.ok(
      getSmtpCommands().some((command) => command.includes(USER_EMAIL)),
      '收件人应当取自快照'
    );
  } finally {
    resetSmtpScript();
  }
});

// ---------------------------------------------------------- 不应当发信

test('用户开关默认关闭：同样的操作一封都不发', async () => {
  const { env } = await setup({ verified: true });
  setSmtpScript();
  try {
    await auditAndNotify(env, changePasswordEvent());
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0, '开关是双向自愿的，默认关闭必须真的拦住');
  } finally {
    resetSmtpScript();
  }
});

test('邮箱尚未验证：即使开关开着也不发', async () => {
  const { env } = await setup({ optIn: true });
  setSmtpScript();
  try {
    await auditAndNotify(env, changePasswordEvent());
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0, '未验证的地址不能作为安全通知的收件人');
  } finally {
    resetSmtpScript();
  }
});

test('邮件未配置：不发信，也不影响调用方', async () => {
  const { env } = await setup({ optIn: true, verified: true, mailConfigured: false });
  setSmtpScript();
  try {
    await auditAndNotify(env, changePasswordEvent());
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
  }
});

test('不在映射表里的动作：不发通知', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  setSmtpScript();
  try {
    await auditAndNotify(env, {
      actorUserId: USER_ID,
      action: 'account.profile.update',
      category: 'security',
      level: 'security',
    });
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0);
  } finally {
    resetSmtpScript();
  }
});

// ------------------------------------------------------------ 失败留痕

test('发信失败会留下一条审计，而不是静默消失', async () => {
  const { handle, env } = await setup({ optIn: true, verified: true });
  setSmtpScript({ failConnect: true });
  try {
    await auditAndNotify(env, changePasswordEvent());
    assert.ok(
      await waitForAudit(handle.connection, 'system.mail.notify.failed'),
      '发不出去必须能在日志中心看见，否则服务商额度耗尽这类问题无人察觉'
    );
  } finally {
    resetSmtpScript();
  }
});

// ------------------------------------------------------------ 新设备 / 新地区

test('新设备登录：发提醒，并把新地区记进历史', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  const storage = new StorageService(env.DB);
  // 一个历史设备 + 本次登录刚写入的新设备（handler 是在写审计之前 upsert 的）
  await storage.upsertDevice(USER_ID, 'old-device', 'Old Phone', 1, 'stamp-old');
  await storage.upsertDevice(USER_ID, 'new-device', 'iPhone 15', 1, 'stamp-new');
  await storage.setConfigValue(countriesKey(), JSON.stringify(['JP']));
  setSmtpScript();
  try {
    await auditAndNotify(env, loginEvent({ newDevice: true, country: 'DE' }));
    await waitForSmtp(1);
    assert.equal(getSmtpConnectCalls().length, 1);
    assert.deepEqual(await readCountries(storage), ['JP', 'DE']);
  } finally {
    resetSmtpScript();
  }
});

test('老设备回到已知地区：不发提醒', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  const storage = new StorageService(env.DB);
  await storage.upsertDevice(USER_ID, 'device-a', 'Phone', 1, 'stamp-a');
  await storage.setConfigValue(countriesKey(), JSON.stringify(['JP']));
  setSmtpScript();
  try {
    await auditAndNotify(env, loginEvent());
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0, '日常登录不该打扰用户');
  } finally {
    resetSmtpScript();
  }
});

test('老设备出现在新地区：发提醒', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  const storage = new StorageService(env.DB);
  await storage.upsertDevice(USER_ID, 'device-a', 'Phone', 1, 'stamp-a');
  await storage.setConfigValue(countriesKey(), JSON.stringify(['JP']));
  setSmtpScript();
  try {
    await auditAndNotify(env, loginEvent({ country: 'DE' }));
    await waitForSmtp(1);
    assert.equal(getSmtpConnectCalls().length, 1);
    assert.deepEqual(await readCountries(storage), ['JP', 'DE']);
  } finally {
    resetSmtpScript();
  }
});

test('全新用户的第一个设备不发提醒', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  const storage = new StorageService(env.DB);
  // 只此一个设备，且国家集合为空：两项都不算「异常」
  await storage.upsertDevice(USER_ID, 'first-device', 'Phone', 1, 'stamp-first');
  setSmtpScript();
  try {
    await auditAndNotify(env, loginEvent({ newDevice: true, country: 'JP' }));
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0, '首次登录必然是「新设备」，提醒只是噪声');
    assert.deepEqual(await readCountries(storage), ['JP'], '但要建立基线');
  } finally {
    resetSmtpScript();
  }
});

test('见过 20 个不同国家后，地区判定对该用户停用', async () => {
  const { env } = await setup({ optIn: true, verified: true });
  const storage = new StorageService(env.DB);
  await storage.upsertDevice(USER_ID, 'device-a', 'Phone', 1, 'stamp-a');
  const twenty = Array.from({ length: 20 }, (_, index) => `${String.fromCharCode(65 + index)}A`);
  await storage.setConfigValue(countriesKey(), JSON.stringify(twenty));
  setSmtpScript();
  try {
    await auditAndNotify(env, loginEvent({ country: 'ZZ' }));
    await settle();
    assert.equal(getSmtpConnectCalls().length, 0, '超过上限说明这个账号本来就在频繁跨国');
  } finally {
    resetSmtpScript();
  }
});

// ------------------------------------------------------------ 登录邮件渲染

test('地区码按收件人语言显示成国家名', () => {
  const occurredAt = new Date('2026-09-23T10:47:00Z');
  const zh = renderNotificationEmail(
    { event: 'new_sign_in', occurredAt, location: 'JP', locationIsNew: true },
    { locale: 'zh-CN' }
  );
  assert.ok(zh.text.includes('日本'), '用 Intl.DisplayNames 本地化，无需维护国家文案表');

  const en = renderNotificationEmail({ event: 'new_sign_in', occurredAt, location: 'JP' }, { locale: 'en' });
  assert.ok(en.text.includes('Japan'));
  assert.ok(!en.text.includes('JP'), '解析成功时不该退化成国家码');
});

test('设备类型按网页端的粒度显示，未定义的类型整行省略', () => {
  const occurredAt = new Date('2026-09-23T10:47:00Z');
  const known = renderNotificationEmail(
    { event: 'new_sign_in', occurredAt, deviceName: 'Chrome', deviceType: 2, deviceIsNew: true },
    { locale: 'zh-CN' }
  );
  assert.ok(known.text.includes('Chrome 扩展'), '与设备管理页用同一个词');
  assert.ok(known.text.includes('设备'));
  assert.ok(known.text.includes('（新）'));

  const unknown = renderNotificationEmail(
    { event: 'new_sign_in', occurredAt, deviceName: 'Mystery', deviceType: 99 },
    { locale: 'zh-CN' }
  );
  assert.ok(unknown.text.includes('Mystery'));
  assert.ok(!unknown.text.includes('类型'), '不要退化成「类型 99」这种数字');
});

test('拿不到地区码时，明细里不出现「位置」行', () => {
  const mail = renderNotificationEmail(
    { event: 'new_sign_in', occurredAt: new Date('2026-09-23T10:47:00Z'), deviceName: 'iPhone 15', deviceType: 1 },
    { locale: 'zh-CN' }
  );
  assert.ok(mail.text.includes('iPhone 15'));
  assert.ok(!mail.text.includes('位置'));
});

test('非登录事件也显示来源地区（不只有「是不是新的」才有用）', async () => {
  const { handle, env } = await setup({ optIn: true, verified: true });
  // 语言决定地区名的写法：地区名在渲染层本地化
  handle.connection.prepare('UPDATE users SET locale = ? WHERE id = ?').run('zh-CN', USER_ID);
  setSmtpScript();
  try {
    await auditAndNotify(env, {
      actorUserId: USER_ID,
      action: 'account.api_key.rotate',
      category: 'security',
      level: 'security',
      targetType: 'user',
      targetId: USER_ID,
      metadata: { country: 'JP' },
    });
    await waitForSmtp(1);
    const body = decodeMimeBodies();
    assert.ok(body.includes('位置'), '轮换密钥这类事件也该看得出从哪来');
    assert.ok(body.includes('日本'), '地区码应当被本地化');
  } finally {
    resetSmtpScript();
  }
});

// ------------------------------------------------------------ 恢复码与通行密钥

test('恢复码、通行密钥的新增与删除都会发提醒', async () => {
  const cases: Array<[string, string]> = [
    ['account.totp.recovery.create', '恢复码'],
    ['account.passkey.create', '通行密钥'],
    ['account.passkey.delete', '通行密钥'],
  ];
  for (const [action, needle] of cases) {
    const { env } = await setup({ optIn: true, verified: true });
    setSmtpScript();
    try {
      await auditAndNotify(env, {
        actorUserId: USER_ID,
        action,
        category: 'security',
        level: 'security',
        targetType: 'user',
        targetId: USER_ID,
        metadata: {},
      });
      await waitForSmtp(1);
      assert.equal(getSmtpConnectCalls().length, 1, `${action} 应当发通知`);
    } finally {
      resetSmtpScript();
    }
    // 邮件正文里用对应语言的说法
    const mail = renderNotificationEmail(
      {
        event: action === 'account.totp.recovery.create'
          ? 'two_step_recovery_created'
          : action === 'account.passkey.create' ? 'passkey_created' : 'passkey_deleted',
        occurredAt: new Date('2026-09-23T10:47:00Z'),
      },
      { locale: 'zh-CN' }
    );
    assert.ok(mail.subject.includes(needle), `${action} 的主题里应当出现「${needle}」`);
  }
});

test('恢复码：首次生成才发通知，重复读取不发', async () => {
  const { handle, env } = await setup({ optIn: true, verified: true });
  const passwordHash = await new AuthService(env).hashPasswordServer('client-hash', USER_EMAIL);
  handle.connection.prepare('UPDATE users SET master_password_hash = ? WHERE id = ?').run(passwordHash, USER_ID);

  const request = (): Request =>
    new Request('https://vault.example.test/api/accounts/totp/recovery-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPasswordHash: 'client-hash' }),
    });

  setSmtpScript();
  try {
    // 这个端点每次打开设置页都会调一次，只有首次才铸新码
    assert.equal((await handleGetTotpRecoveryCode(request(), env, USER_ID)).status, 200);
    await waitForSmtp(1);
    assert.equal(getSmtpConnectCalls().length, 1, '首次生成恢复码应当通知');

    const connectsAfterFirst = getSmtpConnectCalls().length;
    assert.equal((await handleGetTotpRecoveryCode(request(), env, USER_ID)).status, 200);
    await settle();
    assert.equal(
      getSmtpConnectCalls().length,
      connectsAfterFirst,
      '再打开一次设置页只是读回同一枚码，不该再发一封'
    );
  } finally {
    resetSmtpScript();
  }
});

// ------------------------------------------------------------ 收尾文案

test('账户被禁用 / 删除时，不再建议用户去改主密码', () => {
  const occurredAt = new Date('2026-09-23T10:47:00Z');
  for (const event of ['account_disabled', 'account_deleted'] as const) {
    const mail = renderNotificationEmail({ event, occurredAt }, { locale: 'zh-CN' });
    assert.ok(mail.text.includes('联系管理员'), `${event} 应当告诉用户联系管理员`);
    assert.ok(
      !mail.text.includes('修改主密码') && !mail.text.includes('已授权的设备'),
      `${event} 的收件人此时已经登不进去，这两句建议无法执行`
    );
  }

  // 用户自己触发的操作不受影响：那两句正是他当下该做的
  const changed = renderNotificationEmail(
    { event: 'master_password_changed', occurredAt },
    { locale: 'zh-CN' }
  );
  assert.ok(changed.text.includes('修改主密码'));
});

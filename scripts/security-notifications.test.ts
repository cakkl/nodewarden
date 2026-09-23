/**
 * 安全通知邮件的行为验收：盯的是**静默失效** —— 该发时一封不发、或开关关着却照样发。
 * 两者都不报错，只能靠断言钉住。运行方式：`npm run test:security-notifications`
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { AuditEventInput } from '../src/services/audit-events';
import { renderNotificationEmail } from '../src/services/mail';
import { saveMailSettings } from '../src/services/mail-settings';
import { auditAndNotify, notificationRecipientSnapshot } from '../src/services/security-notifications';
import type { Env } from '../src/types';
import {
  getSmtpCommands,
  getSmtpConnectCalls,
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

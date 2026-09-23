// SMTP 客户端与邮件配置的协议级测试。
//
//   npx tsx --import ./scripts/lib/register-cloudflare-stub.mjs --test scripts/mail-smtp-client.test.ts
//
// 覆盖协议顺序与解析、错误分类、超时、口令不泄露、配置存储。
// 不能证明真实网络可达性与证书校验 —— 那是阶段 0 探针的事。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSmtpCommands,
  setSmtpScript,
  type SmtpStubScript,
} from './lib/cloudflare-sockets-stub.mjs';
import { createD1SqliteDatabase } from './lib/d1-sqlite';
import {
  SmtpDeliveryError,
  SmtpReplyParser,
  buildMimeMessage,
  dotStuffBody,
  encodeMimeHeaderValue,
  foldBase64,
  formatAddress,
  formatSmtpDate,
  isPositiveReply,
  parseAuthMethods,
  parseCapabilities,
  pickAuthMethod,
  replyCode,
  sendSmtpMail,
  summarizeReply,
  verifySmtpConnection,
  type SmtpConnectionSettings,
} from '../src/services/smtp-client';
import {
  MailSettingsValidationError,
  getMailSettings,
  inferEncryption,
  normalizeMailSettingsInput,
  resolveMailConnection,
  saveMailSettings,
} from '../src/services/mail-settings';

const SECRET = 'super-secret-smtp-password';

function baseSettings(overrides: Partial<SmtpConnectionSettings> = {}): SmtpConnectionSettings {
  return {
    host: 'smtp.test',
    port: 587,
    encryption: 'starttls',
    username: 'mailer',
    password: SECRET,
    fromAddress: 'noreply@test',
    fromName: 'NodeWarden',
    ...overrides,
  };
}

function script(overrides: Partial<SmtpStubScript> = {}): void {
  setSmtpScript(overrides);
}

/**
 * `assert.rejects()` 解析后不返回错误对象，拿不到 `stage` / `code` 这类字段。
 * 这里自己捕获并断言类型。
 */
async function expectSmtpError(run: () => Promise<unknown>): Promise<SmtpDeliveryError> {
  let caught: unknown = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected the call to fail');
  assert.ok(
    caught instanceof SmtpDeliveryError,
    `expected an SmtpDeliveryError, got ${String(caught)}`
  );
  return caught as SmtpDeliveryError;
}

// ---------------------------------------------------------------- 纯函数

test('RFC 2047：纯 ASCII 头原样返回，中文头按 UTF-8 base64 编码', () => {
  assert.equal(encodeMimeHeaderValue('NodeWarden'), 'NodeWarden');
  assert.equal(encodeMimeHeaderValue(''), '');

  const encoded = encodeMimeHeaderValue('节点守卫');
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const payload = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
  );
  assert.equal(decoded, '节点守卫');
});

test('RFC 2047：长中文标题分段，且不切断 UTF-8 多字节序列', () => {
  const long = '这是一个非常长的中文邮件标题'.repeat(6);
  const encoded = encodeMimeHeaderValue(long);
  const parts = encoded.split(' ');

  assert.ok(parts.length > 1, '超过 45 字节就必须分段');
  for (const part of parts) {
    // 每段独立可解码 ⇒ 没有把多字节字符劈成两半
    const payload = part.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).length > 0, true);
  }
  const joined = parts
    .map((part) => {
      const payload = part.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
      const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    })
    .join('');
  assert.equal(joined, long);
});

test('点填充：以 . 开头的正文行补一个点，行尾统一 CRLF', () => {
  assert.equal(dotStuffBody('.hidden'), '..hidden');
  assert.equal(dotStuffBody('line1\n.hidden\r\nline3'), 'line1\r\n..hidden\r\nline3');
  assert.equal(dotStuffBody('a\n\nb'), 'a\r\n\r\nb');
  // 正文中间的孤立点也必须被填充，否则服务器会提前结束 DATA
  assert.equal(dotStuffBody('x\n.\ny'), 'x\r\n..\r\ny');
});

test('信封地址与日期格式', () => {
  assert.equal(formatAddress('a@b.c'), '<a@b.c>');
  assert.equal(formatAddress('<a@b.c>'), '<a@b.c>');
  assert.equal(formatAddress('  a@b.c  '), '<a@b.c>');

  const stamp = formatSmtpDate(new Date('2026-09-21T06:30:30Z'));
  assert.equal(stamp, 'Mon, 21 Sep 2026 06:30:30 +0000');
});

test('base64 正文按 76 字符折行', () => {
  const folded = foldBase64('A'.repeat(200));
  const lines = folded.split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].length, 76);
  assert.equal(lines.at(-1)!.length, 200 - 76 * 2);
});

test('MIME 报文：中文主题被编码、正文 base64 可完整还原', () => {
  const message = buildMimeMessage(
    { fromAddress: 'noreply@test', fromName: '节点守卫' },
    { to: 'user@test', subject: '登录通知', text: '第一行\n.第二行\n第三行' },
    { now: new Date('2026-09-21T06:30:30Z'), messageId: 'fixed-id@nodewarden.invalid' }
  );

  assert.match(message, /^From: =\?UTF-8\?B\?[^?]+\?= <noreply@test>$/m);
  assert.match(message, /^To: <user@test>$/m);
  assert.match(message, /^Subject: =\?UTF-8\?B\?[^?]+\?=$/m);
  assert.match(message, /^Date: Mon, 21 Sep 2026 06:30:30 \+0000$/m);
  assert.match(message, /^Message-ID: <fixed-id@nodewarden\.invalid>$/m);
  assert.match(message, /^Content-Transfer-Encoding: base64$/m);
  // 正文经过 base64 ⇒ 原始的 `.第二行` 不会以明文出现在报文里
  assert.ok(!message.includes('.第二行'));

  const body = message.split('\r\n\r\n')[1];
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(body.replace(/\r\n/g, '')), (character) => character.charCodeAt(0))
  );
  assert.equal(decoded, '第一行\n.第二行\n第三行');
});

test('EHLO 能力解析与认证方式选择', () => {
  const capabilities = parseCapabilities([
    '250-smtp.test at your service',
    '250-SIZE 41943040',
    '250-AUTH PLAIN LOGIN',
    '250 SMTPUTF8',
  ]);
  assert.deepEqual(capabilities, ['smtp.test at your service', 'SIZE 41943040', 'AUTH PLAIN LOGIN', 'SMTPUTF8']);

  assert.deepEqual(parseAuthMethods(capabilities), ['plain', 'login']);
  assert.deepEqual(parseAuthMethods(['AUTH LOGIN']), ['login']);
  assert.deepEqual(parseAuthMethods(['AUTH=PLAIN']), ['plain']);
  assert.deepEqual(parseAuthMethods(['SIZE 1000']), []);

  // 优先 PLAIN（一次往返）；都没宣告时返回 null —— 不盲目猜测
  assert.equal(pickAuthMethod(['AUTH LOGIN PLAIN']), 'plain');
  assert.equal(pickAuthMethod(['AUTH LOGIN']), 'login');
  assert.equal(pickAuthMethod(['SIZE 1000']), null);
});

test('状态码判定与摘要', () => {
  assert.equal(replyCode('250 2.0.0 Ok'), 250);
  assert.equal(replyCode('250-Ok'), 250);
  assert.equal(replyCode('oops'), null);

  assert.equal(isPositiveReply(220), true);
  assert.equal(isPositiveReply(354), true);
  assert.equal(isPositiveReply(421), false);
  assert.equal(isPositiveReply(535), false);
  assert.equal(isPositiveReply(null), false);

  assert.equal(summarizeReply(['250-A', '250-B', '']), '250-A 250-B');
  assert.equal(summarizeReply(['x'.repeat(400)]).length, 300);
});

test('SmtpReplyParser：单行、多行续行、分块喂入', () => {
  const parser = new SmtpReplyParser();

  parser.push(new TextEncoder().encode('220 hello\r\n'));
  assert.deepEqual(parser.takeReply(), ['220 hello']);
  assert.equal(parser.takeReply(), null);

  // 续行必须在收到终止行之后才算一条完整回复
  parser.push(new TextEncoder().encode('250-SIZE\r\n250-AUTH PLAIN\r\n'));
  assert.equal(parser.takeReply(), null);
  parser.push(new TextEncoder().encode('250 SMTPUTF8\r\n'));
  assert.deepEqual(parser.takeReply(), ['250-SIZE', '250-AUTH PLAIN', '250 SMTPUTF8']);

  // 一次喂入两条回复 ⇒ 分两次取出
  parser.push(new TextEncoder().encode('221 bye\r\n500 nope\r\n'));
  assert.deepEqual(parser.takeReply(), ['221 bye']);
  assert.deepEqual(parser.takeReply(), ['500 nope']);

  // 半个字节流不应产出结果
  parser.push(new TextEncoder().encode('250 split\r'));
  assert.equal(parser.takeReply(), null);
});

// ---------------------------------------------------------------- 会话（隐式 TLS）

test('隐式 TLS：secureTransport=on，AUTH PLAIN 一次成功并完成投递', async () => {
  script({});
  const result = await sendSmtpMail(
    baseSettings({ port: 465, encryption: 'implicit' }),
    { to: 'user@test', subject: 'hi', text: 'body' }
  );

  assert.equal(result.authMethod, 'plain');
  assert.equal(result.encryption, 'implicit');
  assert.match(result.response, /queued as TEST-QUEUE-ID/);

  const commands = getSmtpCommands();
  assert.match(commands[0], /^EHLO /);
  assert.ok(commands.some((command) => command.startsWith('AUTH PLAIN ')));
  assert.ok(!commands.includes('STARTTLS'), '隐式 TLS 不该发 STARTTLS');
  assert.deepEqual(
    commands.filter((command) => /^(MAIL FROM|RCPT TO|DATA|QUIT)/.test(command)).map((command) =>
      command.split(' ')[0]
    ),
    ['MAIL', 'RCPT', 'DATA', 'QUIT']
  );
});

test('隐式 TLS：connect() 收到 secureTransport=on 与 allowHalfOpen=false', async () => {
  script({});
  const { getSmtpConnectCalls } = await import('./lib/cloudflare-sockets-stub.mjs');
  await sendSmtpMail(baseSettings({ port: 465, encryption: 'implicit' }), {
    to: 'user@test',
    subject: 's',
    text: 'b',
  });
  const calls = getSmtpConnectCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'smtp.test');
  assert.equal(calls[0].port, 465);
  assert.equal(calls[0].options.secureTransport, 'on');
  assert.equal(calls[0].options.allowHalfOpen, false);
});

// ---------------------------------------------------------------- 会话（STARTTLS）

test('STARTTLS：升级后重新 EHLO，且 AUTH 只出现在 STARTTLS 之后', async () => {
  script({});
  const result = await sendSmtpMail(baseSettings({ port: 587, encryption: 'starttls' }), {
    to: 'user@test',
    subject: 'hi',
    text: 'body',
  });

  assert.equal(result.encryption, 'starttls');
  const commands = getSmtpCommands();
  const startTlsIndex = commands.indexOf('STARTTLS');
  const authIndex = commands.findIndex((command) => command.startsWith('AUTH '));
  assert.ok(startTlsIndex >= 0, '必须手工发 STARTTLS');
  assert.ok(authIndex > startTlsIndex, 'AUTH 必须在 STARTTLS 之后');

  // EHLO 出现两次：升级前后各一次（TLS 内外的能力集可能不同）
  assert.equal(commands.filter((command) => command.startsWith('EHLO ')).length, 2);
  assert.ok(commands.lastIndexOf('EHLO nodewarden.invalid') < authIndex);
});

test('STARTTLS：connect() 收到 secureTransport=starttls', async () => {
  script({});
  const { getSmtpConnectCalls } = await import('./lib/cloudflare-sockets-stub.mjs');
  await sendSmtpMail(baseSettings({ port: 2587, encryption: 'starttls' }), {
    to: 'user@test',
    subject: 's',
    text: 'b',
  });
  assert.equal(getSmtpConnectCalls()[0].options.secureTransport, 'starttls');
});

test('STARTTLS：服务器强制升级时，隐式 TLS 模式会因缺少升级而被拒（stage=auth）', async () => {
  // requireStartTls ⇒ 未升级即认证时服务器回 538
  script({ requireStartTls: true });
  const error = await expectSmtpError(() =>
    sendSmtpMail(baseSettings({ port: 465, encryption: 'implicit' }), {
      to: 'user@test',
      subject: 's',
      text: 'b',
    })
  );
  assert.equal(error.stage, 'auth');
  assert.equal(error.code, 538);
  assert.match(error.message, /Must issue a STARTTLS command first/);
});

test('STARTTLS：服务器强制升级时，starttls 模式能正常完成', async () => {
  script({ requireStartTls: true });
  const result = await sendSmtpMail(baseSettings({ port: 587, encryption: 'starttls' }), {
    to: 'user@test',
    subject: 's',
    text: 'b',
  });
  assert.equal(result.encryption, 'starttls');
});

test('STARTTLS：忘了 releaseLock 旧流会抛真实运行时错误（回归防线）', async () => {
  // 客户端自己已正确 releaseLock，这里断言的是桩忠实地复现了真实行为
  script({});
  const socket = (await import('./lib/cloudflare-sockets-stub.mjs')).connect(
    { hostname: 'smtp.test', port: 587 },
    { secureTransport: 'starttls', allowHalfOpen: false }
  ) as {
    writable: { getWriter(): { releaseLock(): void } };
    readable: { getReader(): { releaseLock(): void } };
    startTls(options?: Record<string, unknown>): unknown;
  };

  const writer = socket.writable.getWriter();
  assert.throws(() => socket.startTls({}), /currently locked to a writer/);
  writer.releaseLock();

  const reader = socket.readable.getReader();
  assert.throws(() => socket.startTls({}), /currently locked to a reader/);
  reader.releaseLock();

  // 两个流都释放后即可升级
  assert.ok(socket.startTls({ expectedServerHostname: 'smtp.test' }));
});

// ---------------------------------------------------------------- 失败路径

test('认证失败：535 映射为 stage=auth，且错误信息不含口令', async () => {
  script({ authReply: '535 5.7.8 Authentication credentials invalid' });
  const error = await expectSmtpError(() =>
    sendSmtpMail(baseSettings(), { to: 'user@test', subject: 's', text: 'b' })
  );

  assert.equal(error.stage, 'auth');
  assert.equal(error.code, 535);
  assert.ok(!error.message.includes(SECRET), '错误信息绝不能包含口令');
  // AUTH 行的 base64 载荷同样不能出现
  assert.ok(!error.message.includes(btoa(`\u0000mailer\u0000${SECRET}`)));
});

test('投递被拒：stage=data，错误信息带上服务器回复', async () => {
  script({ messageReply: '550 5.1.1 Recipient address rejected' });
  const error = await expectSmtpError(() =>
    sendSmtpMail(baseSettings(), { to: 'nobody@test', subject: 's', text: 'b' })
  );
  assert.equal(error.stage, 'data');
  assert.equal(error.code, 550);
  assert.match(error.message, /Recipient address rejected/);
});

test('发件人被拒：stage=envelope', async () => {
  script({ mailReply: '553 5.7.1 Sender address rejected' });
  const error = await expectSmtpError(() =>
    sendSmtpMail(baseSettings(), { to: 'user@test', subject: 's', text: 'b' })
  );
  assert.equal(error.stage, 'envelope');
  assert.equal(error.code, 553);
});

test('服务器不宣告任何可用认证方式时明确报错，而不是盲目尝试', async () => {
  script({ capabilities: ['SIZE 1000'], capabilitiesTls: ['SIZE 1000'] });
  const error = await expectSmtpError(() =>
    sendSmtpMail(baseSettings(), { to: 'user@test', subject: 's', text: 'b' })
  );
  assert.equal(error.stage, 'auth');
  assert.match(error.message, /AUTH PLAIN \/ AUTH LOGIN/);
  assert.ok(!getSmtpCommands().some((command) => command.startsWith('AUTH ')));
});

test('连接失败：stage=connect', async () => {
  script({ failConnect: true });
  const error = await expectSmtpError(() =>
    sendSmtpMail(baseSettings(), { to: 'user@test', subject: 's', text: 'b' })
  );
  assert.equal(error.stage, 'connect');
  assert.match(error.message, /smtp\.test:587/);
});

test('连上但不回包：由超时兜住（timedOut=true），不会永久悬挂', async () => {
  script({ hangConnect: true });
  const error = await expectSmtpError(() =>
    sendSmtpMail(
      baseSettings(),
      { to: 'user@test', subject: 's', text: 'b' },
      { connectMs: 60, replyMs: 60, overallMs: 500 }
    )
  );
  assert.equal(error.stage, 'connect');
  assert.equal(error.timedOut, true);
});

test('应答慢于预算：由单步超时兜住', async () => {
  script({ replyDelayMs: 400 });
  const error = await expectSmtpError(() =>
    sendSmtpMail(
      baseSettings(),
      { to: 'user@test', subject: 's', text: 'b' },
      { connectMs: 200, replyMs: 80, overallMs: 2_000 }
    )
  );
  assert.equal(error.timedOut, true);
});

test('verifySmtpConnection 能认证但不发信（不产生 MAIL FROM）', async () => {
  script({});
  const verification = await verifySmtpConnection(baseSettings());
  assert.equal(verification.encryption, 'starttls');
  assert.deepEqual(verification.authMethods, ['plain']);
  assert.match(verification.greeting, /220/);
  assert.ok(!getSmtpCommands().some((command) => command.startsWith('MAIL FROM')));
});

test('AUTH LOGIN 回退路径：服务器只宣告 LOGIN 时走两轮 challenge', async () => {
  script({ capabilities: ['AUTH LOGIN'], capabilitiesTls: ['AUTH LOGIN'] });
  const result = await sendSmtpMail(baseSettings(), { to: 'user@test', subject: 's', text: 'b' });
  assert.equal(result.authMethod, 'login');
  const commands = getSmtpCommands();
  assert.ok(commands.includes('AUTH LOGIN'));
  assert.ok(commands.includes(btoa('mailer')));
  assert.ok(commands.includes(btoa(SECRET)));
});

// ---------------------------------------------------------------- 配置校验

test('端口与加密方式的校验规则', () => {
  // 25 被平台禁止 ⇒ 保存时就拒绝（而不是等到发信才失败）
  assert.throws(
    () => normalizeMailSettingsInput({ host: 'smtp.test', port: 25, fromAddress: 'a@b.c' }),
    (error: unknown) => error instanceof MailSettingsValidationError
  );
  assert.throws(
    () => normalizeMailSettingsInput({ host: 'smtp.test', port: 0, fromAddress: 'a@b.c' }),
    MailSettingsValidationError
  );
  assert.throws(
    () => normalizeMailSettingsInput({ host: 'smtp.test', port: 70000, fromAddress: 'a@b.c' }),
    MailSettingsValidationError
  );
  assert.throws(
    () => normalizeMailSettingsInput({ host: 'smtp test', port: 587 }),
    MailSettingsValidationError
  );
  assert.throws(
    () => normalizeMailSettingsInput({ host: 'smtp.test', port: 587, fromAddress: 'not-an-address' }),
    MailSettingsValidationError
  );
  assert.throws(
    () => normalizeMailSettingsInput({ host: 'x'.repeat(300), port: 587 }),
    MailSettingsValidationError
  );

  // 未指明加密方式时按端口推断
  assert.equal(normalizeMailSettingsInput({ host: 'h.test', port: 465 }).encryption, 'implicit');
  assert.equal(normalizeMailSettingsInput({ host: 'h.test', port: 2465 }).encryption, 'implicit');
  assert.equal(normalizeMailSettingsInput({ host: 'h.test', port: 587 }).encryption, 'starttls');
  assert.equal(normalizeMailSettingsInput({ host: 'h.test', port: 2587 }).encryption, 'starttls');
  assert.equal(normalizeMailSettingsInput({ host: 'h.test', port: 2525 }).encryption, 'starttls');
});

test('inferEncryption 与配置读取的默认值', () => {
  assert.equal(inferEncryption(465), 'implicit');
  assert.equal(inferEncryption(2465), 'implicit');
  assert.equal(inferEncryption(587), 'starttls');
  assert.equal(inferEncryption(1), 'starttls');
});

// ---------------------------------------------------------------- 配置存储

function createDb(): { db: D1Database; close: () => void } {
  const sqlite = createD1SqliteDatabase();
  sqlite.connection.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return { db: sqlite.db, close: () => sqlite.close() };
}

const ENV = { JWT_SECRET: 'test-jwt-secret-value-0123456789' } as unknown as Parameters<
  typeof saveMailSettings
>[1];

test('保存后读取：口令不回显，只告知是否已设置', async () => {
  const { db, close } = createDb();
  try {
    const before = await getMailSettings(db);
    assert.equal(before.configured, false);
    assert.equal(before.passwordConfigured, false);

    const saved = await saveMailSettings(db, ENV, {
      enabled: true,
      host: 'smtp.resend.com',
      port: 587,
      encryption: 'starttls',
      username: 'resend',
      fromAddress: 'noreply@test',
      fromName: 'NodeWarden',
      password: SECRET,
    });

    assert.equal(saved.enabled, true);
    assert.equal(saved.host, 'smtp.resend.com');
    assert.equal(saved.port, 587);
    assert.equal(saved.passwordConfigured, true);
    assert.equal(saved.configured, true);
    // 返回值里绝不能出现口令字段
    assert.ok(!Object.keys(saved).some((key) => /password(?!Configured)/i.test(key)));

    // 库里存的是密文：明文口令不能出现在落库的那一行里
    const raw = await db
      .prepare("SELECT value FROM config WHERE key = 'globalSettings__mail__secret'")
      .first<{ value: string }>();
    assert.ok(raw?.value);
    assert.ok(!raw.value.includes(SECRET));
    assert.match(raw.value, /"iv":"/);
  } finally {
    close();
  }
});

test('保存后再保存（口令留空）不会覆盖已存口令', async () => {
  const { db, close } = createDb();
  try {
    await saveMailSettings(db, ENV, {
      enabled: true,
      host: 'smtp.test',
      port: 587,
      encryption: 'starttls',
      username: 'user',
      fromAddress: 'a@b.c',
      fromName: '',
      password: SECRET,
    });

    // 口令留空 ⇒ 保持原值
    const updated = await saveMailSettings(db, ENV, {
      enabled: false,
      host: 'smtp2.test',
      port: 465,
      encryption: 'implicit',
      username: 'user',
      fromAddress: 'a@b.c',
      fromName: '',
    });
    assert.equal(updated.host, 'smtp2.test');
    assert.equal(updated.enabled, false);
    assert.equal(updated.passwordConfigured, true);

    const resolved = await resolveMailConnection(db, ENV);
    assert.equal(resolved.status, 'ok');
    assert.equal(resolved.status === 'ok' && resolved.settings.password, SECRET);
  } finally {
    close();
  }
});

test('有用户名但没有口令时拒绝保存（否则会存下一份必然失败的配置）', async () => {
  const { db, close } = createDb();
  try {
    await assert.rejects(
      saveMailSettings(db, ENV, {
        enabled: true,
        host: 'smtp.test',
        port: 587,
        encryption: 'starttls',
        username: 'user',
        fromAddress: 'a@b.c',
        fromName: '',
      }),
      /password is required/i
    );
  } finally {
    close();
  }
});

test('清空口令时必须同时清空用户名', async () => {
  const { db, close } = createDb();
  try {
    await saveMailSettings(db, ENV, {
      enabled: true,
      host: 'smtp.test',
      port: 587,
      encryption: 'starttls',
      username: 'user',
      fromAddress: 'a@b.c',
      fromName: '',
      password: SECRET,
    });

    // 只清口令、保留用户名 ⇒ 配置将不可用，直接拒绝
    await assert.rejects(
      saveMailSettings(db, ENV, {
        enabled: true,
        host: 'smtp.test',
        port: 587,
        encryption: 'starttls',
        username: 'user',
        fromAddress: 'a@b.c',
        fromName: '',
        clearPassword: true,
      }),
      /clear the username too/i
    );

    // 同时清空用户名 ⇒ 合法（切成无认证中继）
    const cleared = await saveMailSettings(db, ENV, {
      enabled: true,
      host: 'relay.internal',
      port: 2525,
      encryption: 'starttls',
      username: '',
      fromAddress: 'a@b.c',
      fromName: '',
      clearPassword: true,
    });
    assert.equal(cleared.passwordConfigured, false);
    assert.equal(cleared.configured, true);

    const resolved = await resolveMailConnection(db, ENV);
    assert.equal(resolved.status, 'ok');
    assert.equal(resolved.status === 'ok' && resolved.settings.password, '');
  } finally {
    close();
  }
});

test('无用户名的中继配置合法（不要求口令）', async () => {
  const { db, close } = createDb();
  try {
    const saved = await saveMailSettings(db, ENV, {
      enabled: true,
      host: 'relay.internal',
      port: 2525,
      encryption: 'starttls',
      username: '',
      fromAddress: 'a@b.c',
      fromName: '',
    });
    assert.equal(saved.configured, true);
    assert.equal(saved.passwordConfigured, false);

    const resolved = await resolveMailConnection(db, ENV);
    assert.equal(resolved.status, 'ok');
    assert.equal(resolved.status === 'ok' && resolved.settings.password, '');
  } finally {
    close();
  }
});

test('JWT_SECRET 轮换后能明确区分「解不开」与「没配过」', async () => {
  const { db, close } = createDb();
  try {
    await saveMailSettings(db, ENV, {
      enabled: true,
      host: 'smtp.test',
      port: 587,
      encryption: 'starttls',
      username: 'user',
      fromAddress: 'a@b.c',
      fromName: '',
      password: SECRET,
    });

    const rotated = { JWT_SECRET: 'a-completely-different-secret-value' } as unknown as Parameters<
      typeof saveMailSettings
    >[1];

    // 配置还在（提示管理员「已配置但口令读不出来」），而不是伪装成「未配置」
    const settings = await getMailSettings(db);
    assert.equal(settings.host, 'smtp.test');

    const resolved = await resolveMailConnection(db, rotated);
    assert.equal(resolved.status, 'secret-unreadable');
  } finally {
    close();
  }
});

test('未配置任何字段时 resolveMailConnection 返回 not-configured', async () => {
  const { db, close } = createDb();
  try {
    const resolved = await resolveMailConnection(db, ENV);
    assert.equal(resolved.status, 'not-configured');
  } finally {
    close();
  }
});

test('端口被写坏时读取回落到默认值而不是崩溃', async () => {
  const { db, close } = createDb();
  try {
    await db
      .prepare("INSERT INTO config(key, value) VALUES('globalSettings__mail__port', 'not-a-number')")
      .run();
    await db
      .prepare("INSERT INTO config(key, value) VALUES('globalSettings__mail__host', 'smtp.test')")
      .run();
    const settings = await getMailSettings(db);
    assert.equal(settings.port, 587);
    assert.equal(settings.encryption, 'starttls');
  } finally {
    close();
  }
});

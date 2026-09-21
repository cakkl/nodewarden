// `cloudflare:sockets` 的本地桩（测试专用）。
//
// Node 无法解析 `cloudflare:` 协议，所以 SMTP 客户端在测试里需要它。
// 配合 `register-cloudflare-stub.mjs` 的解析钩子使用，同时被测试直接 import
// （同一文件 URL ⇒ ESM 缓存保证是同一实例，`setSmtpScript()` 才能生效）。
//
// 刻意复现两个真实运行时行为：
//   1. `startTls()` 时刻旧 socket 立刻失效；若旧流仍被锁着，抛
//      `This WritableStream is currently locked to a writer.`
//   2. `requireStartTls` 开关模拟服务器回 `538 Must issue a STARTTLS command first`。

const DEFAULT_SCRIPT = {
  greeting: '220 smtp.test ESMTP ready',
  capabilities: ['SIZE 41943040', '8BITMIME', 'AUTH PLAIN LOGIN'],
  capabilitiesTls: ['SIZE 41943040', '8BITMIME', 'AUTH PLAIN LOGIN'],
  startTlsReply: '220 2.0.0 Ready to start TLS',
  /** 认证应答；改成 `535 5.7.8 Authentication credentials invalid` 可测失败路径 */
  authReply: '235 2.7.0 Authentication successful',
  rcptReply: '250 2.1.5 Recipient OK',
  dataReply: '354 End data with <CR><LF>.<CR><LF>',
  messageReply: '250 2.0.0 Ok: queued as TEST-QUEUE-ID',
  mailReply: '250 2.1.0 Sender OK',
  /** true ⇒ 未升级 TLS 时认证返回 `538`（模拟严格执行 STARTTLS 的服务器） */
  requireStartTls: false,
  /** true ⇒ `connect()` 直接抛错（模拟不可达的服务商） */
  failConnect: false,
  /** true ⇒ `opened` 永不 resolve（模拟黑洞地址，用于验证超时确实会触发） */
  hangConnect: false,
  /** 每条命令前的应答延迟（毫秒），用于验证超时预算 */
  replyDelayMs: 0,
};

let currentScript = null;
/** 上一次会话里客户端实际发出的命令（按顺序），用于断言协议顺序 */
let lastCommands = [];
let connectCalls = [];

export function setSmtpScript(overrides = {}) {
  currentScript = { ...DEFAULT_SCRIPT, ...overrides };
  lastCommands = [];
  connectCalls = [];
  return currentScript;
}

export function resetSmtpScript() {
  currentScript = null;
  lastCommands = [];
  connectCalls = [];
}

export function getSmtpCommands() {
  return [...lastCommands];
}

export function getSmtpConnectCalls() {
  return connectCalls.map((call) => ({ ...call }));
}

function script() {
  return currentScript ?? { ...DEFAULT_SCRIPT };
}

function replyLine(code, text) {
  return `${code} ${text}\r\n`;
}

/** 把若干「能力」行拼成 EHLO 的多行应答（除最后一行外都用 `250-` 续行）。 */
function ehloReply(capabilities) {
  const lines = capabilities.map((capability) => `250-${capability}`);
  lines.push('250 SMTPUTF8');
  return lines.join('\r\n') + '\r\n';
}

/** 一个假连接。命令-应答是同步生成的，`replyDelayMs` 用来测超时。 */
class FakeSocket {
  constructor(session, options, isUpgrade = false) {
    this.session = session;
    this.options = options ?? {};
    this.tls = isUpgrade;
    this.dataMode = false;
    this.dataBuffer = [];
    this.inbound = '';
    this.pending = [];
    this.closed = false;
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });

    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        // 只有**首次**建连才送问候语：升级后的 socket 直接继续 SMTP 会话，
        // 重发问候语会让客户端把 `220` 当成 EHLO 的应答而误判。
        if (!isUpgrade) this.push(script().greeting + '\r\n');
      },
      cancel: () => {
        this.closed = true;
      },
    });

    this.writable = new WritableStream({
      write: (chunk) => this.onWrite(new TextDecoder().decode(chunk)),
    });

    this.opened = script().hangConnect
      ? new Promise(() => {})
      : Promise.resolve({ remoteAddress: '203.0.113.10', localAddress: '10.0.0.1' });
  }

  push(text) {
    if (this.closed) return;
    const delay = script().replyDelayMs;
    if (!delay) {
      this.controller.enqueue(new TextEncoder().encode(text));
      return;
    }
    this.pending.push(
      new Promise((resolve) => {
        setTimeout(() => {
          if (!this.closed) this.controller.enqueue(new TextEncoder().encode(text));
          resolve();
        }, delay);
      })
    );
  }

  onWrite(text) {
    this.inbound += text;

    if (this.dataMode) {
      const terminator = this.inbound.indexOf('\r\n.\r\n');
      if (terminator < 0) return;
      const body = this.inbound.slice(0, terminator);
      this.inbound = this.inbound.slice(terminator + 5);
      this.dataMode = false;
      this.dataBuffer.push(body);
      this.push(replyLine(...splitReply(script().messageReply)));
      return;
    }

    for (;;) {
      const breakIndex = this.inbound.indexOf('\r\n');
      if (breakIndex < 0) return;
      const line = this.inbound.slice(0, breakIndex);
      this.inbound = this.inbound.slice(breakIndex + 2);
      this.handleLine(line);
    }
  }

  handleLine(line) {
    lastCommands.push(line);
    const upper = line.toUpperCase();
    const config = script();

    if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
      const capabilities = this.tls ? config.capabilitiesTls : config.capabilities;
      this.push(ehloReply(capabilities));
      return;
    }

    if (upper === 'STARTTLS') {
      if (this.tls) {
        this.push(replyLine(503, '5.5.1 Bad sequence of commands'));
        return;
      }
      // 注意：这里**不能**提前把旧 socket 标记为失效 —— 先得把这个 220 送出去。
      // 旧 socket 的失效发生在客户端真正调用 `startTls()` 时（见下）。
      this.push(config.startTlsReply + '\r\n');
      return;
    }

    // `AUTH LOGIN` 之后的 base64 行既不以 AUTH 开头、也不像任何命令，
    // 必须在分派命令之前先认出来，否则会被当成未知命令回 500。
    if (this.session.loginStage) {
      if (this.session.loginStage === 'username') {
        this.session.loginStage = 'password';
        this.push(replyLine(334, 'UGFzc3dvcmQ6'));
        return;
      }
      this.session.loginStage = null;
      this.push(config.authReply + '\r\n');
      return;
    }

    if (upper.startsWith('AUTH')) {
      // ③ 复现真实行为：未升级 TLS 而服务器强制 STARTTLS ⇒ 538
      if (config.requireStartTls && !this.tls) {
        this.push(replyLine(538, '5.7.0 Must issue a STARTTLS command first'));
        return;
      }
      // `AUTH LOGIN` 需要两轮 challenge；`AUTH PLAIN` 一轮完成
      if (/^AUTH\s+LOGIN\s*$/i.test(line)) {
        this.push(replyLine(334, 'VXNlcm5hbWU6'));
        this.session.loginStage = 'username';
        return;
      }
      this.push(config.authReply + '\r\n');
      return;
    }

    if (upper.startsWith('MAIL FROM')) {
      this.push(config.mailReply + '\r\n');
      return;
    }

    if (upper.startsWith('RCPT TO')) {
      this.push(config.rcptReply + '\r\n');
      return;
    }

    if (upper === 'DATA') {
      this.dataMode = true;
      this.push(config.dataReply + '\r\n');
      return;
    }

    if (upper === 'QUIT') {
      this.push(replyLine(221, '2.0.0 Bye'));
      this.closed = true;
      return;
    }

    this.push(replyLine(500, '5.5.2 Command not recognized'));
  }

  startTls(options) {
    // ② 复现真实运行时错误：旧 socket 的流若仍被锁着，无法升级
    if (this.writable.locked) {
      throw new Error('This WritableStream is currently locked to a writer.');
    }
    if (this.readable.locked) {
      throw new Error('This ReadableStream is currently locked to a reader.');
    }
    // ① 复现真实语义：调用 startTls() 的**那一刻**旧 socket 即刻失效，
    //    但在此之前它必须一直可用（否则 220 应答会被丢掉）。
    this.closed = true;
    const upgraded = new FakeSocket(this.session, options, true);
    this.session.sockets.push(upgraded);
    return upgraded;
  }

  close() {
    this.closed = true;
    this.resolveClose();
    return Promise.resolve();
  }
}

/** 把 `'250 2.0.0 Ok'` 拆成 `[250, '2.0.0 Ok']` */
function splitReply(reply) {
  const match = /^(\d{3})\s*(.*)$/.exec(String(reply).trim());
  return match ? [Number(match[1]), match[2]] : [250, String(reply)];
}

function openSession() {
  const session = { sockets: [], loginStage: null };
  const socket = new FakeSocket(session);
  session.sockets.push(socket);
  return socket;
}

export function connect(address, options) {
  connectCalls.push({ hostname: address?.hostname, port: address?.port, options: options ?? {} });
  const config = script();
  if (config.failConnect) {
    throw new Error('proxy request failed, cannot connect to the specified address');
  }
  if (config.hostnameMismatch && address?.hostname !== config.hostnameMismatch) {
    throw new Error(`unexpected hostname ${address?.hostname}`);
  }
  return openSession();
}

export default { connect };

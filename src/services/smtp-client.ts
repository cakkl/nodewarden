/**
 * 自研 SMTP 客户端。
 *
 * 为什么自研：Workers 没有 `net` / `tls`，`nodemailer` 等库不可用，
 * 只能用 `cloudflare:sockets` 的 `connect()` + `startTls()`。
 *
 * STARTTLS 三个坑（实测，缺一失败）：
 * 1. `secureTransport` 必须写 `'starttls'`，写 `'off'` 手工发 STARTTLS 会被运行时拒绝。
 * 2. `'starttls'` 只是「允许」升级，不会自动升级 —— 仍要手工发 `STARTTLS`、读到 `220`，
 *    再调 `socket.startTls()`。
 * 3. 升级前必须 `releaseLock()` 旧 reader 与 writer；**不能用 `close()` 代替**
 *    （旧 socket 已关闭，其 `close()` 永不 resolve，会挂死请求）。
 */
import { connect } from 'cloudflare:sockets';

type SmtpSocket = ReturnType<typeof connect>;

/** `implicit` = 连上即 TLS；`starttls` = 明文连接后升级 */
export type SmtpEncryption = 'implicit' | 'starttls';

export type SmtpAuthMethod = 'plain' | 'login';

/** 出错环节，供前端挑本地化文案 */
export type SmtpStage =
  | 'connect'
  | 'greeting'
  | 'ehlo'
  | 'starttls'
  | 'auth'
  | 'envelope'
  | 'data'
  | 'quit';

export interface SmtpTimeouts {
  connectMs: number;
  replyMs: number;
  overallMs: number;
}

/**
 * 默认超时预算。
 *
 * ⚠️ 总量必须**明显小于 30 秒**：`ctx.waitUntil()` 只在响应发出后延长 30 秒执行
 * （见 Workers 平台限制），超过会被运行时直接砍掉 —— 那时我们自己的兜底超时
 * 根本来不及生效，失败会以「任务消失」而不是「可读错误」的形式呈现。
 * 25 秒留了 5 秒余量，也足够覆盖实测 0.7–1.0 秒的正常投递。
 */
export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectMs: 8_000,
  replyMs: 10_000,
  overallMs: 25_000,
};

export interface SmtpConnectionSettings {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  username: string;
  password: string;
  /** 信封发件人（MAIL FROM） */
  fromAddress: string;
  fromName?: string;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  /** 纯文本正文；所有客户端都能读，也是 HTML 被拦截时的兜底 */
  text: string;
  /** 可选 HTML 正文。提供时发出 multipart/alternative，不支持 HTML 的客户端仍读 `text`。 */
  html?: string;
}

export interface SmtpDeliveryResult {
  /** 服务器对 `DATA` 结束的最终回复整行 */
  response: string;
  capabilities: string[];
  authMethod: SmtpAuthMethod;
  encryption: SmtpEncryption;
}

export interface SmtpVerificationResult {
  greeting: string;
  capabilities: string[];
  authMethods: SmtpAuthMethod[];
  encryption: SmtpEncryption;
}

/** `stage` / `code` 供前端映射文案；`message` 只可能含服务器回复，不含口令。 */
export class SmtpDeliveryError extends Error {
  constructor(
    message: string,
    readonly stage: SmtpStage,
    readonly code: number | null = null,
    readonly timedOut: boolean = false
  ) {
    super(message);
    this.name = 'SmtpDeliveryError';
  }
}

// ---------------------------------------------------------------- 纯函数（可直接单测）

/** 取回复行的状态码；非数字行返回 null。 */
export function replyCode(line: string): number | null {
  const match = /^(\d{3})([ -]?)/.exec(String(line || '').trim());
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

/** 2xx 与 3xx 算成功（3xx 是 DATA 的 354 中间态）。 */
export function isPositiveReply(code: number | null): boolean {
  return code !== null && code >= 200 && code < 400;
}

/** 把服务器回复压成一行摘要，供错误信息使用。 */
export function summarizeReply(lines: string[]): string {
  return lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

/**
 * RFC 2047 编码：含非 ASCII（中文标题、发件人名）时必须编码，否则收件端会乱码。
 * 纯 ASCII 且不含控制字符时原样返回，避免产生无谓的 `=?UTF-8?B?`。
 * 单段 base64 上限 75 字符（RFC 2047 §2），超出按 UTF-8 字节边界分段。
 */
export function encodeMimeHeaderValue(value: string): string {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(text)) return text;

  const bytes = new TextEncoder().encode(text);
  const chunkBytes = 45; // 45 字节 → base64 60 字符，加包裹共 < 75
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    let end = Math.min(offset + chunkBytes, bytes.length);
    // 不要切断 UTF-8 多字节序列：回退到最后一个合法起始字节
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    let binary = '';
    for (let index = offset; index < end; index += 1) binary += String.fromCharCode(bytes[index]);
    parts.push('=?UTF-8?B?' + btoa(binary) + '?=');
  }
  return parts.join(' ');
}

/** 点填充（RFC 5321 §4.5.2）：以 `.` 开头的行补一个点，否则服务器会当成正文结束。行尾统一 CRLF。 */
export function dotStuffBody(body: string): string {
  const normalized = String(body ?? '').replace(/\r\n|\r|\n/g, '\r\n');
  return normalized
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');
}

/** RFC 5321 信封地址 `<addr>`。 */
export function formatAddress(address: string): string {
  return '<' + String(address || '').trim().replace(/^<|>$/g, '') + '>';
}

/** RFC 5322 日期。用 `+0000` 而不用 `GMT`。 */
export function formatSmtpDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/** 分块转 base64，避免 `String.fromCharCode(...)` 在大数组上爆栈。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** base64 正文按 76 字符折行（RFC 2045 §6.8）。 */
export function foldBase64(value: string): string {
  return (String(value).match(/.{1,76}/g) || []).join('\r\n');
}

/**
 * 组装 MIME 报文。正文用 base64 传输编码，免去中文、长行与点填充的多重处理。
 * 同时给了 `html` 时按 `multipart/alternative` 发送，**纯文本段在前**（RFC 2046 要求
 * 备选内容从简到繁排列，客户端取它能显示的最后一段）。
 */
export function buildMimeMessage(
  settings: Pick<SmtpConnectionSettings, 'fromAddress' | 'fromName'>,
  message: SmtpMessage,
  options: { now?: Date; messageId?: string } = {}
): string {
  const from = String(settings.fromAddress || '').trim();
  const name = String(settings.fromName || '').trim();
  const headerFrom = name ? `${encodeMimeHeaderValue(name)} <${from}>` : formatAddress(from);
  const date = formatSmtpDate(options.now ?? new Date());
  const messageId = options.messageId ?? `${crypto.randomUUID()}@nodewarden.invalid`;
  const headers = [
    `From: ${headerFrom}`,
    `To: ${formatAddress(message.to)}`,
    `Subject: ${encodeMimeHeaderValue(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];

  const textPart = encodeBase64Part(String(message.text ?? ''));
  if (!message.html) {
    return [...headers, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', textPart].join(
      '\r\n'
    );
  }

  const boundary = `nw-${crypto.randomUUID()}`;
  const htmlPart = encodeBase64Part(message.html);
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    textPart,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlPart,
    `--${boundary}--`,
  ].join('\r\n');
}

function encodeBase64Part(body: string): string {
  return foldBase64(bytesToBase64(new TextEncoder().encode(body)));
}

/** 解析 EHLO 多行回复里的能力列表（去掉 `250-` / `250 ` 前缀）。 */
export function parseCapabilities(lines: string[]): string[] {
  const capabilities: string[] = [];
  for (const line of lines) {
    const match = /^\d{3}[ -](.*)$/.exec(String(line || '').trim());
    if (!match) continue;
    const value = match[1].trim();
    if (value) capabilities.push(value);
  }
  return capabilities;
}

/** 解析宣告的 AUTH 机制（`250-AUTH PLAIN LOGIN` → `['plain','login']`）。 */
export function parseAuthMethods(capabilities: string[]): SmtpAuthMethod[] {
  const methods: SmtpAuthMethod[] = [];
  for (const capability of capabilities) {
    const match = /^AUTH[ =](.+)$/i.exec(capability);
    if (!match) continue;
    for (const token of match[1].split(/[\s]+/)) {
      const normalized = token.toLowerCase();
      if (normalized === 'plain' && !methods.includes('plain')) methods.push('plain');
      if (normalized === 'login' && !methods.includes('login')) methods.push('login');
    }
  }
  return methods;
}

/**
 * 优先 PLAIN（比 LOGIN 少一轮往返）。都没宣告时返回 null —— 不盲目尝试，
 * 很多服务商对失败认证计数，猜错会白耗尝试次数。
 */
export function pickAuthMethod(capabilities: string[]): SmtpAuthMethod | null {
  const methods = parseAuthMethods(capabilities);
  if (methods.includes('plain')) return 'plain';
  if (methods.includes('login')) return 'login';
  return null;
}

/** 拒绝在 TLS 之外发送口令。 */
export function assertAuthenticatedOverTls(encryption: SmtpEncryption, startTlsCompleted: boolean): void {
  if (encryption === 'implicit') return;
  if (!startTlsCompleted) {
    throw new SmtpDeliveryError(
      'Refusing to send credentials before TLS was established',
      'starttls'
    );
  }
}

// ---------------------------------------------------------------- 流式回复解析

/** 增量解析 SMTP 回复；多行回复以 `250-` 续行、`250 ` 结束。 */
export class SmtpReplyParser {
  private buffer = '';
  /** 已读但回复尚未结束的续行。跨 chunk 时不能丢，否则会把中间行当成最终结果。 */
  private pending: string[] = [];
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
  }

  /** 取出一整条回复（含续行）；数据不足时返回 null。 */
  takeReply(): string[] | null {
    for (;;) {
      const breakIndex = this.buffer.indexOf('\r\n');
      if (breakIndex < 0) return null;
      const line = this.buffer.slice(0, breakIndex);
      this.buffer = this.buffer.slice(breakIndex + 2);
      this.pending.push(line);

      const match = /^(\d{3})([ -]?)/.exec(line);
      if (!match) {
        // 非标准行：原样交给调用方判定
        const lines = this.pending;
        this.pending = [];
        return lines;
      }
      if (match[2] === '-') continue;
      const lines = this.pending;
      this.pending = [];
      return lines;
    }
  }

  /** 丢弃残留内容（TLS 升级后必须调用）。 */
  reset(): void {
    this.buffer = '';
    this.pending = [];
  }
}

// ---------------------------------------------------------------- 会话

function withStageTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage: SmtpStage,
  action: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SmtpDeliveryError(`The mail server did not respond while ${action}`, stage, null, true));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/** 一封信一条连接：每个请求是独立 isolate，跨请求复用 TCP 连接不可行。 */
class SmtpSession {
  private socket: SmtpSocket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private parser = new SmtpReplyParser();
  private startTlsCompleted = false;

  private constructor(
    socket: SmtpSocket,
    private readonly settings: SmtpConnectionSettings,
    private readonly timeouts: SmtpTimeouts
  ) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  static async open(settings: SmtpConnectionSettings, timeouts: SmtpTimeouts): Promise<SmtpSession> {
    let socket: SmtpSocket;
    try {
      // 写 'off' 再手工发 STARTTLS 会被运行时拒绝，starttls 模式必须在此声明。
      socket = connect(
        { hostname: settings.host, port: settings.port },
        settings.encryption === 'implicit'
          ? { secureTransport: 'on', allowHalfOpen: false }
          : { secureTransport: 'starttls', allowHalfOpen: false }
      );
    } catch (error) {
      throw new SmtpDeliveryError(
        `Could not connect to ${settings.host}:${settings.port} (${errorMessage(error)})`,
        'connect'
      );
    }
    // 隐式 TLS 的握手在 opened 里完成
    try {
      await withStageTimeout(socket.opened, timeouts.connectMs, 'connect', 'connecting');
    } catch (error) {
      throw asDeliveryError(error, 'connect', `Could not connect to ${settings.host}:${settings.port}`);
    }
    return new SmtpSession(socket, settings, timeouts);
  }

  private async readReply(stage: SmtpStage, action: string): Promise<string[]> {
    for (;;) {
      const reply = this.parser.takeReply();
      if (reply) return reply;
      const chunk = await withStageTimeout(this.reader.read(), this.timeouts.replyMs, stage, action);
      if (chunk.done) {
        throw new SmtpDeliveryError(`The mail server closed the connection while ${action}`, stage);
      }
      if (chunk.value) this.parser.push(chunk.value);
    }
  }

  private async command(line: string, stage: SmtpStage, action: string): Promise<string[]> {
    try {
      await withStageTimeout(
        this.writer.write(new TextEncoder().encode(line + '\r\n')),
        this.timeouts.replyMs,
        stage,
        action
      );
    } catch (error) {
      throw asDeliveryError(error, stage, `Could not send the request while ${action}`);
    }
    return this.readReply(stage, action);
  }

  /** 发命令并断言首行状态码落在期望范围内。 */
  private async expect(
    line: string,
    stage: SmtpStage,
    action: string,
    expected: (code: number) => boolean
  ): Promise<string[]> {
    const reply = await this.command(line, stage, action);
    const code = replyCode(reply[0] ?? '');
    if (code === null || !expected(code)) {
      throw new SmtpDeliveryError(
        `The mail server refused while ${action}: ${summarizeReply(reply)}`,
        stage,
        code
      );
    }
    return reply;
  }

  async greeting(): Promise<string> {
    const reply = await this.readReply('greeting', 'reading the greeting');
    const code = replyCode(reply[0] ?? '');
    if (code !== 220) {
      throw new SmtpDeliveryError(
        `Unexpected greeting from the mail server: ${summarizeReply(reply)}`,
        'greeting',
        code
      );
    }
    return reply[0];
  }

  async ehlo(): Promise<string[]> {
    // 用保留域名，避免泄露部署细节
    const reply = await this.expect('EHLO nodewarden.invalid', 'ehlo', 'saying EHLO', (code) => code === 250);
    return parseCapabilities(reply);
  }

  /** STARTTLS 升级：必须先 releaseLock 旧流，**不能用 close()**（详见文件头）。 */
  async startTls(): Promise<string[]> {
    await this.expect('STARTTLS', 'starttls', 'starting TLS', (code) => code === 220);
    try {
      this.reader.releaseLock();
    } catch {
      // 可能仍有未决 read，忽略
    }
    try {
      this.writer.releaseLock();
    } catch {
      // 同上
    }
    // 不传 `expectedServerHostname`：部分运行时版本会拒绝该选项
    // （`startTls called with unsupported expectedServerHostname option`）。
    // 证书仍按 `connect()` 时的 hostname 校验（即 SNI 与校验目标一致）。
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.parser.reset();
    this.startTlsCompleted = true;
    // 升级后必须重新 EHLO：认证通常在 TLS 内才被宣告。
    return this.ehlo();
  }

  async authenticate(capabilities: string[]): Promise<SmtpAuthMethod> {
    assertAuthenticatedOverTls(this.settings.encryption, this.startTlsCompleted);
    const method = pickAuthMethod(capabilities);
    if (!method) {
      throw new SmtpDeliveryError(
        'The mail server does not advertise a supported authentication method (AUTH PLAIN / AUTH LOGIN)',
        'auth'
      );
    }
    if (method === 'plain') {
      const payload = btoa('\u0000' + this.settings.username + '\u0000' + this.settings.password);
      await this.expect(`AUTH PLAIN ${payload}`, 'auth', 'authenticating', (code) => code === 235);
      return method;
    }
    await this.expect('AUTH LOGIN', 'auth', 'authenticating', (code) => code === 334);
    await this.expect(btoa(this.settings.username), 'auth', 'authenticating', (code) => code === 334);
    await this.expect(btoa(this.settings.password), 'auth', 'authenticating', (code) => code === 235);
    return method;
  }

  async deliver(message: SmtpMessage): Promise<string> {
    await this.expect(
      `MAIL FROM:${formatAddress(this.settings.fromAddress)}`,
      'envelope',
      'setting the sender',
      (code) => code === 250
    );
    await this.expect(
      `RCPT TO:${formatAddress(message.to)}`,
      'envelope',
      'setting the recipient',
      (code) => code === 250 || code === 251
    );
    await this.expect('DATA', 'data', 'starting the message body', (code) => code === 354);

    const mime = buildMimeMessage(this.settings, message);
    const payload = dotStuffBody(mime) + '\r\n.\r\n';
    try {
      await withStageTimeout(
        this.writer.write(new TextEncoder().encode(payload)),
        this.timeouts.replyMs,
        'data',
        'sending the message body'
      );
    } catch (error) {
      throw asDeliveryError(error, 'data', 'Could not send the message body');
    }
    const reply = await this.readReply('data', 'waiting for the delivery result');
    const code = replyCode(reply[0] ?? '');
    if (code !== 250) {
      throw new SmtpDeliveryError(
        `The mail server rejected the message: ${summarizeReply(reply)}`,
        'data',
        code
      );
    }
    return summarizeReply(reply);
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT', 'quit', 'saying QUIT');
    } catch {
      // 失败不影响已拿到的投递结果
    }
  }

  async close(): Promise<void> {
    try {
      await withStageTimeout(this.socket.close(), 2_000, 'quit', 'closing the connection');
    } catch {
      // 连接会由运行时回收
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asDeliveryError(error: unknown, stage: SmtpStage, fallback: string): SmtpDeliveryError {
  if (error instanceof SmtpDeliveryError) return error;
  return new SmtpDeliveryError(`${fallback} (${errorMessage(error)})`, stage);
}

// ---------------------------------------------------------------- 跨会话的总体超时

async function withOverallTimeout<T>(run: () => Promise<T>, timeouts: SmtpTimeouts): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SmtpDeliveryError('The mail server did not finish in time', 'connect', null, true));
    }, timeouts.overallMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 对外入口

/** 建连并完成 AUTH，不发信。用于「测试连接」。 */
export async function verifySmtpConnection(
  settings: SmtpConnectionSettings,
  timeouts: SmtpTimeouts = DEFAULT_SMTP_TIMEOUTS
): Promise<SmtpVerificationResult> {
  return withOverallTimeout(async () => {
    const session = await SmtpSession.open(settings, timeouts);
    try {
      const greeting = await session.greeting();
      let capabilities = await session.ehlo();
      if (settings.encryption === 'starttls') {
        capabilities = await session.startTls();
      }
      const authMethod = await session.authenticate(capabilities);
      await session.quit();
      return {
        greeting,
        capabilities,
        authMethods: [authMethod],
        encryption: settings.encryption,
      };
    } finally {
      await session.close();
    }
  }, timeouts);
}

/** 投递一封纯文本邮件。失败一律抛 `SmtpDeliveryError`。 */
export async function sendSmtpMail(
  settings: SmtpConnectionSettings,
  message: SmtpMessage,
  timeouts: SmtpTimeouts = DEFAULT_SMTP_TIMEOUTS
): Promise<SmtpDeliveryResult> {
  return withOverallTimeout(async () => {
    const session = await SmtpSession.open(settings, timeouts);
    try {
      await session.greeting();
      let capabilities = await session.ehlo();
      if (settings.encryption === 'starttls') {
        capabilities = await session.startTls();
      }
      const authMethod = await session.authenticate(capabilities);
      const response = await session.deliver(message);
      await session.quit();
      return {
        response,
        capabilities,
        authMethod,
        encryption: settings.encryption,
      };
    } finally {
      await session.close();
    }
  }, timeouts);
}

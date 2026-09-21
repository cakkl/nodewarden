// `cloudflare-sockets-stub.mjs` 的类型声明。
//
// 为什么需要单独声明：桩必须是 `.mjs`（由 Node 直接加载，不走 tsx 转译），
// 而 TS 测试要 import 它拿 `setSmtpScript()` 之类的控制面。没有这份声明，
// `tsc -p tsconfig.scripts.json` 会报「找不到声明文件」。

export interface SmtpStubScript {
  greeting: string;
  capabilities: string[];
  capabilitiesTls: string[];
  startTlsReply: string;
  authReply: string;
  mailReply: string;
  rcptReply: string;
  dataReply: string;
  messageReply: string;
  /** true ⇒ 未升级 TLS 时认证返回 `538 Must issue a STARTTLS command first` */
  requireStartTls: boolean;
  /** true ⇒ `connect()` 直接抛错 */
  failConnect: boolean;
  /** true ⇒ `opened` 永不 resolve（用于验证超时确实会触发） */
  hangConnect: boolean;
  /** 每条应答前的延迟（毫秒），用于验证超时预算 */
  replyDelayMs: number;
  /** 非空时，`connect()` 遇到其它 hostname 会抛错 */
  hostnameMismatch?: string;
}

export function setSmtpScript(overrides?: Partial<SmtpStubScript>): SmtpStubScript;
export function resetSmtpScript(): void;
/** 上一次会话里客户端实际发出的命令（按顺序） */
export function getSmtpCommands(): string[];
export function getSmtpConnectCalls(): Array<{
  hostname?: string;
  port?: number;
  options: Record<string, unknown>;
}>;
export function connect(
  address: { hostname: string; port: number },
  options?: Record<string, unknown>
): unknown;
declare const _default: { connect: typeof connect };
export default _default;

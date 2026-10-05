// 上游在此内联 data: URL 桩，但 tsx 不解析它（ERR_UNSUPPORTED_ESM_URL_SCHEME），且没桩
// `cloudflare:sockets`（本仓 SMTP 用到）⇒ 复用 file: URL 桩（socket 桩要求同一 URL 命中同一实例）。
import './lib/register-cloudflare-stub.mjs';

// WebsiteIcon 等 webapp 模块会读 Vite 注入的构建常量。
globalThis.__NODEWARDEN_DEMO__ = false;

// 注册模块解析钩子：把 `cloudflare:*` 重定向到本地桩。
//
// 用法（必须用 --import 预加载）：
//   NODE_OPTIONS="--import=./scripts/lib/register-cloudflare-stub.mjs" npx tsx --test ...
//
// 原因：`cloudflare:workers`（DO / waitUntil）与 `cloudflare:sockets`（SMTP 客户端）
// 都是 Workers 虚拟模块，Node 无法解析，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
//
// 本文件刻意写成 .mjs：由 Node 直接加载，不经过 tsx 转译。
import { registerHooks } from 'node:module';

const STUB_URL = new URL('./cloudflare-workers-stub.mjs', import.meta.url).href;
const SOCKETS_STUB_URL = new URL('./cloudflare-sockets-stub.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: STUB_URL, shortCircuit: true };
    }
    // 解析到**文件 URL**：测试用相对路径 import 同一文件时会命中同一实例，
    // `setSmtpScript()` 才能影响到 `connect()`。
    if (specifier === 'cloudflare:sockets') {
      return { url: SOCKETS_STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

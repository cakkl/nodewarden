// 注册模块解析钩子：把 `cloudflare:*` 重定向到本地桩。
//
// 用法（必须用 --import 预加载）：
//   NODE_OPTIONS="--import=./scripts/lib/register-cloudflare-stub.mjs" npx tsx --test ...
//
// 为什么需要：`cloudflare:workers` 与 `cloudflare:sockets` 都是 Workers 运行时的虚拟模块，Node 无法
// 解析（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）—— 前者供 notifications-hub（DO / waitUntil），后者供
// SMTP 客户端。没有它，所有间接引用这些模块的 handler（ciphers、folders、sends、identity…）
// 都无法在 Node 测试里导入。
//
// 刻意写成 .mjs：由 Node 直接加载，不经过 tsx 转译。
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

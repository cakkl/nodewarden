import type { Env } from './types';

const BACKEND_PATH_PREFIXES = [
  '/api',
  '/identity',
  '/icons',
  '/fill-assist',
  '/notifications',
  '/.well-known',
  // Compatibility aliases retained for older Bitwarden clients.
  '/devices',
  '/auth-requests',
  '/webauthn',
] as const;

const BACKEND_EXACT_PATHS = new Set([
  '/v1/assetlinks:check',
  '/web-bootstrap',
  '/config',
  '/accounts/kdf',
  '/settings/domains',
  // 下面这些是「官方客户端用裸路径、本仓也注册了 /api 变体」的兼容别名。
  // ⚠️ 漏掉它们的后果：隐藏模式下会被 404（而不是走到 handler 的 501/正常逻辑），
  // 其中 `/accounts/resend-new-device-otp` 正是官方界面「重新发送验证码」按钮用的路径 ⇒ 用户无法重发。
  // 新增裸别名时**必须同步登记在这里**；`scripts/web-vault-visibility.test.ts` 有漂移护栏。
  '/accounts/resend-new-device-otp',
  '/accounts/request-otp',
  '/accounts/verify-otp',
  '/two-factor/send-email-login',
  '/two-factor/get-email',
  '/two-factor/email',
]);

export function isBackendRequestPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  if (BACKEND_EXACT_PATHS.has(path)) return true;

  return BACKEND_PATH_PREFIXES.some((prefix) => (
    path === prefix || path.startsWith(`${prefix}/`)
  ));
}

export function isWebVaultHidden(env: Env): boolean {
  return String(env.HIDE_WEB_VAULT || '').trim() === '1';
}

export function webVaultNotFoundResponse(request: Request): Response {
  const body = request.method === 'HEAD' ? null : 'Not Found';
  return new Response(body, {
    status: 404,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    },
  });
}

/**
 * 路由路径的单一事实来源。
 *
 * 页面路径只在这里定义一次；别名、判定用的「合法路径全集」、`AppMainRoutes` 必须注册的
 * 路径清单都从它推导 —— 以前这些散在三处，改一个路径要在多处同步，漏一处就是白屏或 404。
 */

/** 规范路径。改路径只改这里。 */
export const ROUTES = {
  home: '/',
  login: '/login',
  register: '/register',
  lock: '/lock',
  recoverTwoFactor: '/recover-2fa',

  vault: '/vault',
  vaultTotp: '/vault/totp',
  sends: '/sends',
  generator: '/generator',
  passwordHealth: '/security/password-health',

  settings: '/settings',
  settingsAccount: '/settings/account',
  settingsDomainRules: '/settings/domain-rules',
  deviceManagement: '/settings/security/device-management',

  backup: '/backup',
  importExport: '/backup/import-export',
  admin: '/admin',
  logs: '/logs',
  help: '/help',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

/** 直接注册成 `<Route>` 的旧路径：页面原样渲染，不做跳转。 */
export const DIRECT_ALIASES = {
  deviceManagementLegacy: '/security/devices',
} as const;

/** 命中后要跳到规范路径的旧路径。 */
export const REDIRECT_ALIASES = {
  importExport: ['/tools/import', '/tools/import-export', '/tools/import-data', '/import', '/import-export'],
} as const;

/** import / export 页的全部入口（规范路径 + 旧别名）。 */
export const IMPORT_EXPORT_ROUTE_PATHS = [ROUTES.importExport, ...REDIRECT_ALIASES.importExport] as const;
export const IMPORT_EXPORT_ROUTE_ALIASES: ReadonlySet<string> = new Set(REDIRECT_ALIASES.importExport);

/** 设备管理的全部入口。 */
export const DEVICE_MANAGEMENT_ROUTE_PATHS = [ROUTES.deviceManagement, DIRECT_ALIASES.deviceManagementLegacy] as const;

/** 未登录可达的路径，由 `AuthViews` 处理，不在 `AppMainRoutes` 的 `Switch` 里。 */
export const AUTH_ROUTE_PATHS = [
  ROUTES.home,
  ROUTES.login,
  ROUTES.register,
  ROUTES.lock,
  ROUTES.recoverTwoFactor,
] as const;

/** `AppMainRoutes` 的 `Switch` 必须注册的全部路径（含直接别名与需跳转的别名）。 */
export const SHELL_ROUTE_PATHS = [
  ROUTES.home,
  ROUTES.vault,
  ROUTES.vaultTotp,
  ROUTES.sends,
  ROUTES.generator,
  ROUTES.passwordHealth,
  ROUTES.settings,
  ROUTES.settingsAccount,
  ROUTES.settingsDomainRules,
  ROUTES.backup,
  ROUTES.admin,
  ROUTES.logs,
  ROUTES.help,
  // 这两组由 `AppMainRoutes` 用 `.map()` 展开，各自**都**包含规范路径与别名。
  // 别只展开别名部分 —— 曾经因此漏掉 `/backup/import-export` 本身，直接访问会 404。
  ...IMPORT_EXPORT_ROUTE_PATHS,
  ...DEVICE_MANAGEMENT_ROUTE_PATHS,
] as const;

const AUTH_ROUTES: ReadonlySet<string> = new Set(AUTH_ROUTE_PATHS);
const SHELL_ROUTES: ReadonlySet<string> = new Set(SHELL_ROUTE_PATHS);

/** 公开的 Send 链接（`/send/<id>`）不在路径表里，但同样算合法入口。 */
export const PUBLIC_SEND_PATH_PATTERN = /^\/send(?:\/|$)/i;

/** 判定「这个路径是已知入口吗」，用于决定渲染 404 还是继续走路由。 */
export function isKnownRoutePath(path: string): boolean {
  return AUTH_ROUTES.has(path) || SHELL_ROUTES.has(path) || PUBLIC_SEND_PATH_PATTERN.test(path);
}

/** 规范化路径：去 query / hash 片段、补前导斜杠、去尾部斜杠（`/` 除外）。 */
export function normalizeRoutePath(path: string): string {
  const pathOnly = String(path || '/').split('?')[0].split('#')[0];
  const normalized = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/';
}

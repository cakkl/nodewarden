/**
 * 路由路径的单一事实来源：路径只在这里定义一次，别名、判定全集、`Switch` 必须注册的
 * 清单都从它推导。
 */

/** 规范路径。改路径只改这里。 */
export const ROUTES = {
  home: '/',
  login: '/login',
  register: '/register',
  lock: '/lock',

  vault: '/vault',
  vaultTotp: '/vault/totp',
  sends: '/sends',
  generator: '/generator',
  passwordHealth: '/security/password-health',

  // 机密管理器（独立产品；产品归属由路径派生，见下面的 isSecretsProductPath）
  secrets: '/secrets',
  secretsProjects: '/secrets/projects',
  secretsMachineAccounts: '/secrets/machine-accounts',

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
] as const;

/** `AppMainRoutes` 的 `Switch` 必须注册的全部路径（含直接别名与需跳转的别名）。 */
export const SHELL_ROUTE_PATHS = [
  ROUTES.home,
  ROUTES.vault,
  ROUTES.vaultTotp,
  ROUTES.sends,
  ROUTES.generator,
  ROUTES.passwordHealth,
  ROUTES.secrets,
  ROUTES.secretsProjects,
  ROUTES.secretsMachineAccounts,
  ROUTES.settings,
  ROUTES.settingsAccount,
  ROUTES.settingsDomainRules,
  ROUTES.backup,
  ROUTES.admin,
  ROUTES.logs,
  ROUTES.help,
  // 这两组由 `AppMainRoutes` 用 `.map()` 展开，各自都含规范路径与别名（别只展开别名）。
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

/** 机密管理器产品的全部页面路径。 */
export const SECRETS_PRODUCT_PATHS = [
  ROUTES.secrets,
  ROUTES.secretsProjects,
  ROUTES.secretsMachineAccounts,
] as const;

/**
 * 该路径是否属于**机密管理器**产品。
 *
 * 产品归属由路径派生（`/vault…` = 密码管理器、`/secrets…` = 机密管理器），**不存独立的
 * 开关状态**：开关与 URL 一旦能互相矛盾，刷新 / 深链 / 书签 / 后退都会出问题。
 */
export function isSecretsProductPath(path: string): boolean {
  return (SECRETS_PRODUCT_PATHS as readonly string[]).includes(normalizeRoutePath(path));
}

/** 规范化路径：去 query / hash 片段、补前导斜杠、去尾部斜杠（`/` 除外）。 */
export function normalizeRoutePath(path: string): string {
  const pathOnly = String(path || '/').split('?')[0].split('#')[0];
  const normalized = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/';
}

/**
 * 把旧的 hash 形态分享链接（`#/send/<id>/<key>`）换成路径形态；不是旧链接返回 `null`。
 *
 * ⚠️ 路由只读路径，hash 会被当成根路径 ⇒ 旧链接会落到登录页；已发出去的链接收不回来，
 * 所以必须在渲染前替换（见 `main.tsx`）。
 */
export function legacyPublicSendPath(hash: string): string | null {
  const match = /^#\/?(send\/[^/]+(?:\/[^/]+)?)\/?$/i.exec(String(hash || ''));
  return match ? `/${match[1]}` : null;
}

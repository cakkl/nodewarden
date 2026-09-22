// 路由路径表的护栏：把「路径清单」与「AppMainRoutes 实际注册的 Route」钉成一一对应。
//
// 为什么值得测：这两份清单以前是两块独立维护的字符串数组。第 33 项（未匹配路由 → 内容区
// 渲染 null → 只剩导航栏）就是它们脱节造成的，而当时没有任何测试会红。现在路径只在
// `webapp/src/lib/routes.ts` 定义，本文件确保「表里有的都注册了」「注册了的都在表里」，
// 并禁止其它文件再写回裸路径字面量。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  AUTH_ROUTE_PATHS,
  DEVICE_MANAGEMENT_ROUTE_PATHS,
  DIRECT_ALIASES,
  IMPORT_EXPORT_ROUTE_ALIASES,
  IMPORT_EXPORT_ROUTE_PATHS,
  REDIRECT_ALIASES,
  ROUTES,
  SHELL_ROUTE_PATHS,
  isKnownRoutePath,
} from '../../webapp/src/lib/routes';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 抽取 `path="…"` 与 `path={…}` 的取值：字面量返回 `"值"`，表达式返回其原文。 */
export function extractRoutePathTokens(source: string): string[] {
  const tokens: string[] = [];
  const pattern = /\bpath=(?:"([^"]*)"|\{([^}]*)\})/g;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    tokens.push(match[1] !== undefined ? `"${match[1]}"` : match[2].trim());
    match = pattern.exec(source);
  }
  return tokens;
}

const MAIN_ROUTES_FILE = 'webapp/src/components/AppMainRoutes.tsx';
const mainRoutesTokens = extractRoutePathTokens(readSource(MAIN_ROUTES_FILE));

/** `ROUTES` 的值 → 键（用于把路径反查成 `ROUTES.<key>`）。`/` 只出现一次，不会撞。 */
const routeKeyByValue = new Map<string, string>();
for (const [key, value] of Object.entries(ROUTES)) {
  if (!routeKeyByValue.has(value)) routeKeyByValue.set(value, key);
}

/** 由 `.map()` 展开的数组：源码里必须直接引用其符号，否则展开断言不成立。 */
const MAPPED_ROUTE_ARRAYS = [
  { symbol: 'IMPORT_EXPORT_ROUTE_PATHS', paths: IMPORT_EXPORT_ROUTE_PATHS as readonly string[] },
  { symbol: 'DEVICE_MANAGEMENT_ROUTE_PATHS', paths: DEVICE_MANAGEMENT_ROUTE_PATHS as readonly string[] },
];

// ---------------------------------------------------------------- 护栏自检

test('护栏自检：扫描器能分出字面量、ROUTES 引用与动态 path', () => {
  const fixture = [
    '<Route path="/literal" />',
    '<Route path={ROUTES.vault} />',
    '<Route key={path} path={path} />',
  ].join('\n');
  assert.deepEqual(extractRoutePathTokens(fixture), ['"/literal"', 'ROUTES.vault', 'path']);
});

test('护栏自检：扫描器真的扫到了东西（防改名后静默扫到 0 处）', () => {
  assert.ok(mainRoutesTokens.length >= 15, `只扫到 ${mainRoutesTokens.length} 个 path，疑似扫描失效`);
});

// ---------------------------------------------------------------- 双向一致

test('AppMainRoutes 里每个 Route 都在路径表内（防「注册了没登记」）', () => {
  const registered = new Set<string>();
  for (const token of mainRoutesTokens) {
    if (token === 'path') continue; // 由 MAPPED_ROUTE_ARRAYS 的 .map 展开，单独断言
    if (token.startsWith('ROUTES.')) {
      const key = token.slice('ROUTES.'.length) as keyof typeof ROUTES;
      assert.ok(key in ROUTES, `Route 引用了不存在的 ROUTES.${key}`);
      registered.add(ROUTES[key]);
      continue;
    }
    // 裸字面量已被下面的专项测试禁止，这里仍解析出来以便报错更具体
    registered.add(token.slice(1, -1));
  }

  const declared = new Set<string>(SHELL_ROUTE_PATHS);
  for (const pathValue of registered) {
    assert.ok(declared.has(pathValue), `${MAIN_ROUTES_FILE} 注册了未登记的路径：${pathValue}`);
  }
});

test('路径表里每个 Shell 路径都在 AppMainRoutes 里注册了（防「登记了没注册」）', () => {
  const registeredTokens = new Set(mainRoutesTokens);
  for (const symbol of MAPPED_ROUTE_ARRAYS) {
    assert.ok(registeredTokens.has('path'), 'AppMainRoutes 丢失了 .map 展开的 Route');
    assert.ok(readSource(MAIN_ROUTES_FILE).includes(symbol.symbol), `AppMainRoutes 未引用 ${symbol.symbol}`);
  }

  for (const pathValue of SHELL_ROUTE_PATHS) {
    if (MAPPED_ROUTE_ARRAYS.some((entry) => entry.paths.includes(pathValue))) continue;
    const key = routeKeyByValue.get(pathValue);
    assert.ok(key, `SHELL_ROUTE_PATHS 里的 ${pathValue} 不在 ROUTES 中`);
    assert.ok(
      registeredTokens.has(`ROUTES.${key}`),
      `SHELL_ROUTE_PATHS 登记了 ${pathValue}，但 ${MAIN_ROUTES_FILE} 里没有 <Route path={ROUTES.${key}}>`
    );
  }
});

test('AppMainRoutes 不再使用裸路径字面量', () => {
  const literals = mainRoutesTokens.filter((token) => token.startsWith('"'));
  assert.deepEqual(literals, [], `请改用 ROUTES.*：${literals.join(', ')}`);
});

// 这一条是补漏：曾经 SHELL_ROUTE_PATHS 只展开了「别名」，漏掉规范路径本身
// （`/backup/import-export`），直接访问会 404，而当时所有护栏都是绿的。
test('由 .map() 展开的数组成员必须登记在 SHELL_ROUTE_PATHS 里', () => {
  const declared = new Set<string>(SHELL_ROUTE_PATHS);
  const missing: string[] = [];
  for (const entry of MAPPED_ROUTE_ARRAYS) {
    for (const pathValue of entry.paths) {
      if (!declared.has(pathValue)) missing.push(`${entry.symbol} → ${pathValue}`);
    }
  }
  assert.deepEqual(missing, [], `这些路径会被渲染但未登记为合法路径：\n${missing.join('\n')}`);
});

// ---------------------------------------------------------------- 单一来源

test('界面路径不再以裸字面量出现在其它文件（统一走 ROUTES）', () => {
  const files = [
    'webapp/src/App.tsx',
    'webapp/src/components/AppMainRoutes.tsx',
    'webapp/src/components/AppAuthenticatedShell.tsx',
    'webapp/src/components/VaultPage.tsx',
    'webapp/src/lib/demo.ts',
  ];
  // `'/'` 太通用（`split('/')`、默认路径等遍地都是），不纳入扫描。
  const literals = Object.values(ROUTES)
    .filter((value) => value !== ROUTES.home)
    .flatMap((value) => [`'${value}'`, `"${value}"`]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = readSource(file);
    for (const literal of literals) {
      if (source.includes(literal)) offenders.push(`${file} → ${literal}`);
    }
  }
  assert.deepEqual(offenders, [], `这些地方应当引用 ROUTES.*：\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------- 表自身的自洽

test('别名表与规范路径不重叠，且别名都在「合法路径全集」内', () => {
  const canonical = new Set<string>(Object.values(ROUTES));
  for (const alias of [...REDIRECT_ALIASES.importExport, DIRECT_ALIASES.deviceManagementLegacy]) {
    assert.ok(!canonical.has(alias), `${alias} 既是别名又是规范路径`);
    assert.ok(isKnownRoutePath(alias), `别名 ${alias} 未被算作合法路径`);
  }
});

test('IMPORT_EXPORT_ROUTE_PATHS = 规范路径 + 全部别名', () => {
  assert.equal(IMPORT_EXPORT_ROUTE_PATHS[0], ROUTES.importExport);
  assert.equal(IMPORT_EXPORT_ROUTE_PATHS.length, REDIRECT_ALIASES.importExport.length + 1);
  assert.deepEqual(
    [...IMPORT_EXPORT_ROUTE_ALIASES].sort(),
    [...REDIRECT_ALIASES.importExport].sort()
  );
});

test('登录前后的路径都被算作已知（否则会被误判成 404）', () => {
  for (const pathValue of [...AUTH_ROUTE_PATHS, ...SHELL_ROUTE_PATHS]) {
    assert.ok(isKnownRoutePath(pathValue), `${pathValue} 被判成未知路径`);
  }
});

test('未知路径不被算作已知', () => {
  for (const pathValue of ['/not-a-route', '/vault/unknown/sub']) {
    assert.equal(isKnownRoutePath(pathValue), false, `${pathValue} 不应算作已知路径`);
  }
});

test('公开 Send 链接算作已知入口', () => {
  // 缺 id 的 `/send` 也命中该模式：它是「合法入口」但不是可渲染的页面，
  // 由 `App.tsx` 的 `isMalformedSendRoute` 拦下并渲染 404。
  assert.equal(isKnownRoutePath('/send/abc123'), true);
  assert.equal(isKnownRoutePath('/send/abc123/key'), true);
});

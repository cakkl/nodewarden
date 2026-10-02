// `HIDE_WEB_VAULT=1` 的允许清单护栏：**router 里注册的每个顶层路径都必须被判定为后端路径**。
//
// 为什么需要：`isBackendRequestPath()` 原本是「Worker 会自己处理的路径」清单，被复用成了隐藏模式白名单
// ⇒ 两者不同步就是静默缺陷（`/accounts/resend-new-device-otp` 曾被 404，用户无法重发验证码）。
//
// 运行方式：npm run test:hide-web-vault
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isBackendRequestPath, isWebVaultHidden, webVaultNotFoundResponse } from '../src/web-vault-visibility';
import type { Env } from '../src/types';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_FILES = readdirSync(path.join(REPO_ROOT, 'src')).filter((file) => /^router.*\.ts$/.test(file));

/** 这些是「子路径片段」（`/api/ciphers/{id}` 的后半段），不是顶层路径 ⇒ 不该被判定为后端路径。 */
const SUB_PATH_ONLY = new Set([
  '/archive', '/attachment', '/attachment/v2', '/delete', '/details', '/partial',
  '/remove-auth', '/remove-password', '/restore', '/share', '/unarchive',
]);

/**
 * 抽出 router 里所有「顶层请求路径」字面量（`path === '/x'` / `path.startsWith('/x')`）。
 * 只看 `path` 本身 —— `subPath`/`pathname` 是局部变量，不是顶层路径。
 */
function extractTopLevelPaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const record = (value: string, where: string) => {
    if (!value.startsWith('/')) return;
    if (!found.has(value)) found.set(value, []);
    found.get(value)!.push(where);
  };

  for (const file of ROUTER_FILES) {
    const source = readFileSync(path.join(REPO_ROOT, 'src', file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      for (const match of line.matchAll(/\bpath\s*===?\s*'([^']+)'/g)) record(match[1], where);
      for (const match of line.matchAll(/\bpath\s*\.startsWith\(\s*'([^']+)'/g)) record(match[1], where);
    });
  }
  return found;
}

test('router 里注册的每个顶层路径，在隐藏模式下都必须仍可用', () => {
  const paths = extractTopLevelPaths();
  assert.ok(paths.size >= 40, `只抽到 ${paths.size} 个路径 —— router 写法变了，本护栏要跟着改`);

  const blocked = [...paths.entries()]
    .filter(([value]) => !SUB_PATH_ONLY.has(value) && !isBackendRequestPath(value))
    .sort((a, b) => a[0].localeCompare(b[0]));

  assert.deepEqual(
    blocked.map(([value]) => value),
    [],
    '这些路径在 HIDE_WEB_VAULT=1 下会被 404。若是有意的（例如官方客户端用不到），请登记到 SUB_PATH_ONLY 并写明理由；'
    + '否则把它们加进 src/web-vault-visibility.ts 的 BACKEND_EXACT_PATHS'
  );
});

test('扫描器自检：抽得到已知裸别名，且不会把子路径片段当顶层路径', () => {
  const paths = extractTopLevelPaths();
  // 已知在 router 里注册过的裸别名
  for (const known of ['/accounts/resend-new-device-otp', '/accounts/request-otp', '/accounts/verify-otp']) {
    assert.ok(paths.has(known), `扫描器没抽到 ${known} —— 它应当仍在 router 里注册`);
  }
  // 子路径片段不该被当成顶层路径
  for (const sub of SUB_PATH_ONLY) {
    assert.ok(!paths.has(sub), `${sub} 是子路径片段，不该出现在抽取结果里`);
  }
});

test('Web Vault 本体必须被拦（与上一组断言互为反向，防止清单被放得过宽）', () => {
  for (const webVaultPath of ['/', '/vault', '/assets/index-abc.js', '/sw.js', '/manifest.webmanifest', '/index.html']) {
    assert.equal(
      isBackendRequestPath(webVaultPath),
      false,
      `${webVaultPath} 属于 Web Vault 本体 —— 若它被判定为后端路径，隐藏模式就形同虚设`
    );
  }
  // 客户端链路必须放行
  for (const backendPath of ['/api/sync', '/identity/connect/token', '/icons/x.com/favicon.ico', '/notifications/hub', '/api/attachments/a/b']) {
    assert.equal(isBackendRequestPath(backendPath), true, `${backendPath} 必须放行`);
  }
});

test('开关只认 `1`，404 响应形状与文档一致', async () => {
  assert.equal(isWebVaultHidden({ HIDE_WEB_VAULT: '1' } as Env), true);
  assert.equal(isWebVaultHidden({ HIDE_WEB_VAULT: ' 1 ' } as Env), true, '两端空白应容忍');
  for (const notHidden of [undefined, '', '0', 'true', 'yes', '01']) {
    assert.equal(
      isWebVaultHidden({ HIDE_WEB_VAULT: notHidden } as Env),
      false,
      `HIDE_WEB_VAULT=${JSON.stringify(notHidden)} 不该启用隐藏模式（删除变量即可恢复，文档如此承诺）`
    );
  }

  const response = webVaultNotFoundResponse(new Request('https://vault.example.test/vault'));
  assert.equal(response.status, 404);
  assert.match(String(response.headers.get('Cache-Control')), /no-store/);
  assert.equal(await response.text(), 'Not Found');

  const headResponse = webVaultNotFoundResponse(new Request('https://vault.example.test/vault', { method: 'HEAD' }));
  assert.equal(headResponse.status, 404);
  assert.equal(await headResponse.text(), '', 'HEAD 不该有 body');
});

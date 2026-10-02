// `lib/api/vault.ts`（63 KB 源码）只在解锁后才被调用，却是入口 chunk 里最大的非 tree-shake 模块
// ⇒ 用 `vault-lazy.ts` 惰性转发把它移出首屏（实测首屏 −5.2 KB gzip）。
// 破了不报错：漏掉某个转发 ⇒ 调用点运行时拿到 `undefined`；某模块又静态引回 vault.ts ⇒ 首屏又变胖。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VAULT_SPECIFIER = '@/lib/api/vault';
const LAZY_SPECIFIER = '@/lib/api/vault-lazy';

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 在 `webapp/src` 下按谓词挑源码文件（返回相对仓库根的路径，已排序）。 */
function listSourceFiles(predicate: (source: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && predicate(readFileSync(full, 'utf8'))) {
        found.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'webapp/src'));
  return found.sort();
}

/** 去掉纯类型 import（编译期擦除，与打包无关），避免把 `import type` 也算成依赖。 */
function stripTypeImports(source: string): string {
  return source.replace(/import\s+type\s+[\s\S]*?from\s*['"][^'"]+['"];?/g, '');
}

test('vault-lazy 与 vault.ts 的运行时导出一一对应', () => {
  const vault = readSource('webapp/src/lib/api/vault.ts');
  const lazy = readSource('webapp/src/lib/api/vault-lazy.ts');

  const exported = [...vault.matchAll(/^export async function (\w+)/gm)].map((match) => match[1]).sort();
  assert.ok(exported.length >= 20, `只扫到 ${exported.length} 个导出 —— vault.ts 写法变了，本护栏要跟着改`);

  const forwarded = [...lazy.matchAll(/^export const (\w+) = forward\('(\w+)'\);/gm)].map((match) => {
    assert.equal(match[1], match[2], '导出的变量名要与转发的函数名一致');
    return match[1];
  }).sort();
  assert.deepEqual(forwarded, exported, '漏掉的导出会让调用点在运行时拿到 undefined');

  // 类型要一起转出去，否则调用方改用 vault-lazy 后会报「找不到 CiphersImportPayload」
  assert.match(lazy, /export type \{[^}]*CiphersImportPayload[^}]*\} from '\.\/vault'/, '类型也要重新导出');
});

/**
 * 该源码是否以 `from '<说明符>'` 形式静态引用（先把空白压平，不依赖具体换行 / 缩进）。
 * ⚠️ 不拼正则：动态构造 + 部分字符转义会被安全扫描器判成风险（PR 评论里出现过）。
 */
function importsFrom(source: string, specifier: string): boolean {
  const flat = source.replace(/\s+/g, ' ');
  return flat.includes(`from '${specifier}'`) || flat.includes(`from "${specifier}"`);
}

test('除 vault-lazy 外，没有模块静态引用 vault.ts', () => {
  const importers = listSourceFiles((source) => importsFrom(stripTypeImports(source), VAULT_SPECIFIER));
  assert.deepEqual(importers, [], `静态引用会把 63 KB 的 vault.ts 拉回首屏，请改成 ${LAZY_SPECIFIER}`);
});

test('vault-lazy 只通过动态 import 取 vault.ts', () => {
  const lazy = readSource('webapp/src/lib/api/vault-lazy.ts');
  assert.doesNotMatch(lazy, /^import\s+[\s\S]*?from\s*'\.\/vault'/m, '不得静态引入');
  assert.match(lazy, /import\('\.\/vault'\)/, '要走动态 import');
  assert.match(lazy, /vaultApiLoader \?\?= import\('\.\/vault'\)/, '加载结果必须缓存，否则每次调用都会触发一次 import');
});

test('调用方已改到 vault-lazy', () => {
  const callers = listSourceFiles((source) => importsFrom(source, LAZY_SPECIFIER));
  assert.deepEqual(
    callers,
    ['webapp/src/App.tsx', 'webapp/src/hooks/useVaultSendActions.ts'],
    '这两个是唯一的入口侧调用方 —— 少了一个，说明它又静态引回 vault.ts 了'
  );
});

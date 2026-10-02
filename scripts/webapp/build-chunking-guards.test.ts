// 分包护栏：破了不报错，只会静默多下载。
// ⚠️ 最容易踩的坑是「只把静态 import 改成动态」—— 被移出的模块若命中 `shared` 组
//（≥2 个模块引用 + ≥50 KB）就会回到首屏（`shared` 是 modulepreload 的），净收益 0。
// ⇒ 词表要单独分组且优先级更高；jsQR 要保证全仓只有一处引入点。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 在 `webapp/src` 下挑出满足条件的源码文件，返回相对仓库根的路径（已排序）。 */
function listSourceFiles(predicate: (source: string) => boolean, extensions = /\.(ts|tsx)$/): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.test(entry.name) && predicate(readFileSync(full, 'utf8'))) {
        found.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'webapp/src'));
  return found.sort();
}

/**
 * 取某个 `codeSplitting` 分组的 priority：组内 `name` 在前、`priority` 在后
 * ⇒ 找 `name:` 之后的第一个 `priority:`。
 * ⚠️ 用字符串定位而不是拼正则 —— 动态构造的正则会被安全扫描器判成 ReDoS 风险（PR 评论里出现过）。
 */
function groupPriority(config: string, groupName: string): number {
  const anchor = `name: '${groupName}'`;
  const anchorAt = config.indexOf(anchor);
  assert.ok(anchorAt >= 0, `vite.config.ts 里找不到名为 ${groupName} 的 codeSplitting 分组`);
  const rest = config.slice(anchorAt + anchor.length);
  const priorityAt = rest.indexOf('priority:');
  assert.ok(priorityAt >= 0, `${groupName} 分组没有 priority —— 写法变了，本护栏要跟着改`);
  const parsed = Number.parseInt(rest.slice(priorityAt + 'priority:'.length).trim(), 10);
  assert.ok(Number.isFinite(parsed), `${groupName} 分组的 priority 不是数字`);
  return parsed;
}

test('词表必须单独成 chunk，且优先级高过 shared 组', () => {
  const config = readSource('webapp/vite.config.ts');
  const wordList = groupPriority(config, 'eff-word-list');
  assert.ok(
    wordList > groupPriority(config, 'shared'),
    'eff-word-list 分组的优先级必须高于 shared，否则词表会被 shared 收进去 → 首屏白等 60.7 KB'
  );
  assert.match(config, /name:\s*'eff-word-list'[\s\S]*?test:\s*\/.*eff-word-list/);
});

test('指纹短语按需加载词表，不能静态 import', () => {
  const source = readSource('webapp/src/lib/api/auth-requests.ts');
  assert.doesNotMatch(
    source,
    /import\s*\{[^}]*EFFLongWordList[^}]*\}\s*from/,
    '静态 import 会把词表拉到 auth-requests 所在的 chunk 上（首屏）'
  );
  assert.match(source, /await import\((['"])@\/lib\/eff-word-list\1\)/);
  assert.match(source, /wordList\.length/, '词数要从加载到的列表里取，不能写死');
});

test('词表在源码里只有一份', () => {
  assert.equal(
    existsSync(path.join(REPO_ROOT, 'webapp/src/lib/fingerprint-wordlist.ts')),
    false,
    '曾有一份与 eff-word-list.ts 逐字节相同的副本，两份都会各自进包'
  );

  assert.deepEqual(
    listSourceFiles((source) => source.includes('export const EFFLongWordList')),
    ['webapp/src/lib/eff-word-list.ts']
  );
});

// jsQR（min 后 129 KB）只作原生 BarcodeDetector 失效时的兜底，却曾静态引入 ⇒
// 绑进库页 chunk（解锁后的默认落地页），每个用户每次解锁都多下 46 KB gzip。
const JSQR_MODULE = 'jsqr';

/**
 * 找出以静态 / 动态 import 引用某模块的文件（`require()` 归为静态）。
 * 同样不拼正则：扫描器对动态正则会报 ReDoS。
 */
function listFilesImportingModule(moduleName: string, mode: 'static' | 'dynamic'): string[] {
  const tokens = [`'${moduleName}'`, `"${moduleName}"`];
  return listSourceFiles((source) => {
    for (const token of tokens) {
      let at = source.indexOf(token);
      while (at >= 0) {
        const isDynamicImport = /import\s*\(\s*$/.test(source.slice(Math.max(0, at - 20), at));
        if (isDynamicImport === (mode === 'dynamic')) return true;
        at = source.indexOf(token, at + token.length);
      }
    }
    return false;
  });
}

test('jsQR 只能按需加载', () => {
  const editor = readSource('webapp/src/components/vault/VaultEditor.tsx');
  assert.doesNotMatch(
    editor,
    /import\s+jsQR\s+from\s*['"]jsqr['"]/,
    '静态 import 会把 jsQR 绑进库页 chunk（库页是解锁后的默认落地页）⇒ 每个用户必下'
  );
  assert.match(editor, /import\((['"])jsqr\1\)/, 'jsQR 必须走动态 import');
  assert.match(editor, /await loadJsQr\(\)/, '解码必须经由惰性加载器，别在解码函数里直接 import');
});

test('jsQR 全仓只有一处引入点，且是动态的', () => {
  assert.deepEqual(
    listFilesImportingModule(JSQR_MODULE, 'static'),
    [],
    '不允许任何静态引入（`require()` 也算静态）'
  );
  assert.deepEqual(
    listFilesImportingModule(JSQR_MODULE, 'dynamic'),
    ['webapp/src/components/vault/VaultEditor.tsx'],
    '一旦有第二处引入，jsQR（>50 KB）会被 shared 组收走 —— 而 shared 是首屏 modulepreload 的'
  );
});

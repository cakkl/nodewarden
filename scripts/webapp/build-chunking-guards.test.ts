// 词表分包的护栏：破了不报错，只会在首屏静默多下载 60.7 KB。
// 最容易踩的坑是「只把静态 import 改成动态」—— 词表会被 `shared` 组收走，而 `shared` 是首屏 modulepreload 的，
// 于是主包瘦多少、shared 就胖多少（净收益 0）⇒ 必须单独分组且优先级更高。
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

// 组内 `name` 在前、`priority` 在后 ⇒ 「name 之后的第一个 priority」就是它自己的。
function groupPriority(config: string, groupName: string): number {
  const match = config.match(new RegExp(`name:\\s*'${groupName}'[\\s\\S]*?priority:\\s*(\\d+)`));
  assert.ok(match, `vite.config.ts 里找不到名为 ${groupName} 的 codeSplitting 分组`);
  return Number(match[1]);
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

  const declared: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes('export const EFFLongWordList')) {
        declared.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'webapp/src/lib'));
  assert.deepEqual(declared, ['webapp/src/lib/eff-word-list.ts']);
});

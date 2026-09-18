// 「前端不要把服务端错误文案吞掉」的源码护栏（docs/TODO.md 第 21 条）。
//
// 背景：`webapp/src/lib/api/**` 里原有 **32 处**写成
//   if (!resp.ok) throw new Error('Create item failed');
// 它们把服务端的 `error_description` / `error` **整个丢掉**，于是：
//   · 主密码输错 → 用户只看到「创建失败」，无从自救；
//   · 命中限流（429）/ 权限（403）→ 同样只剩一句笼统的失败。
// 正确的形态是把服务端文案接过来再本地化：
//   if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_…')));
// 老代码里还有等价的 `translateServerError(body?.error_description || body?.error, t('…'))`
// （手动 parseJson 的版本）—— 两种都算合格，本护栏只禁「完全不吃服务端文案」的写法。
//
// 为什么必须用护栏而不是靠人记：第 5/20/21 条已经是**第三次**修同一个模式了
// （管理端 2 处 → 邀请码 4 处 → 全仓 32 处），加护栏才能止住。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const API_ROOT = path.join(REPO_ROOT, 'webapp', 'src', 'lib', 'api');

/** `if (!resp.ok)` / `if (!rawResp.ok)` / `if (!pre.ok)` 这类失败分支守卫 */
const GUARD_RE = /if\s*\(\s*![\w.]*\.ok\s*\)/g;
/** 实参里出现这两个函数之一 = 把服务端文案接住了 */
const ACCEPTED_CALLS = ['parseErrorMessage(', 'translateServerError('];

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** 取守卫之后的分支体：`{ … }` 块（按括号配对）或同一行的余下内容 */
function extractBranchBody(afterGuard: string): string {
  const rest = afterGuard.trimStart();
  if (!rest.startsWith('{')) return rest.split('\n')[0];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return rest.slice(0, i + 1);
    }
  }
  return rest;
}

/** 取出分支体里每个 `throw new Error(...)` 的实参原文 */
function extractThrowArguments(body: string): string[] {
  const args: string[] = [];
  const pattern = /throw new Error\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = match.index + match[0].length - 1; i < body.length; i += 1) {
      const char = body[i];
      if (quote) {
        if (char === '\\') i += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    args.push(body.slice(match.index + match[0].length, end));
  }
  return args;
}

interface ScanResult {
  guards: number;
  violations: string[];
}

function scanApiSource(relative: string, source: string): ScanResult {
  const violations: string[] = [];
  let guards = 0;
  for (const match of source.matchAll(GUARD_RE)) {
    guards += 1;
    const body = extractBranchBody(source.slice(match.index + match[0].length));
    for (const argument of extractThrowArguments(body)) {
      if (ACCEPTED_CALLS.some((call) => argument.includes(call))) continue;
      violations.push(`${relative}:${lineOf(source, match.index)}  throw new Error(${argument.replace(/\s+/g, ' ').slice(0, 80)})`);
    }
  }
  return { guards, violations };
}

function collectApiFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath ?? dir, entry.name))
    .sort();
}

// ---------------------------------------------------------------- 扫描器自检
// 护栏本身写错（例如括号配对错、正则漏掉块形式）会**静默放行**，所以先把它的判断钉住。
test('扫描器自检：同行形式 / 块形式 / 两种合格写法 / 不带服务端文案的写法', () => {
  const fixture = [
    "if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_a')));", // 合格
    "if (!resp.ok) throw new Error(translateServerError(body?.error, t('txt_b')));", // 合格（老写法）
    "if (!resp.ok) throw new Error('Create item failed');", // 违规
    'if (!resp.ok) {',                                     // 违规（块形式）
    "  throw new Error('Bulk delete failed');",
    '}',
    'if (!pre.ok) {',                                      // 合格（块形式 + 合格写法）
    "  throw new Error(await parseErrorMessage(pre, t('txt_c')));",
    '}',
    'if (!resp.ok) return null;',                          // 不是 throw，跳过
  ].join('\n');

  const result = scanApiSource('fixture.ts', fixture);
  assert.equal(result.guards, 6, '6 个守卫都要被扫到（含 return 型那个）');
  assert.equal(result.violations.length, 2, '只有两处完全不吃服务端文案');
  assert.match(result.violations[0], /fixture\.ts:3/);
  assert.match(result.violations[1], /fixture\.ts:4/);
});

test('扫描器自检：嵌套括号与模板字符串不会把实参截断', () => {
  const fixture = "if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_x', { a: f(1, 2) })));";
  const result = scanApiSource('fixture.ts', fixture);
  assert.deepEqual(result.violations, []);
});

// ---------------------------------------------------------------- 主断言
test('webapp/src/lib/api 下所有失败分支都必须接住服务端文案', () => {
  const violations: string[] = [];
  let guards = 0;

  for (const file of collectApiFiles(API_ROOT)) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const result = scanApiSource(relative, readFileSync(file, 'utf8'));
    guards += result.guards;
    violations.push(...result.violations);
  }

  assert.deepEqual(
    violations,
    [],
    '这些失败分支把服务端文案丢掉了（用户会看到一句笼统的「失败」，无法自救，见 docs/TODO 第 21 条）：\n'
      + `${violations.join('\n')}\n`
      + "修法：throw new Error(await parseErrorMessage(resp, t('txt_…')))—— "
      + 'fallback 文案用已有的键，别新造（第 21 条实测 32 处全部能复用现有键）'
  );

  // 防「正则失效 ⇒ 静默扫到 0 个守卫」：那时上面那条断言永远是绿的
  assert.ok(guards >= 100, `只扫到 ${guards} 个失败分支守卫，疑似扫描器失效（实测基线 110）`);
});

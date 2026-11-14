// 跨请求共享 promise 的源码护栏。
//
// compat date 2024-10-14 起，promise 只能在创建它的那次请求里 settle；创建者提前结束时
// 其续期被丢弃、永不 settle ⇒ 模块级引用成死 promise，该 isolate 之后每个请求都报
// “created by a request that has since ended”（2026-11-13 因此让备份连续失败三轮）。
// 正确做法：模块级只存状态（布尔 / 枚举 + 时间戳），需要等待时在当前请求里轮询。
//
// 运行方式：npm run test:cross-request-promise
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC_ROOT = path.resolve(import.meta.dirname, '..', 'src');

// 模块级（顶格）声明的 Promise：类型注解或初始化表达式里出现 Promise 都算。
// 函数内的局部 promise 由当前请求创建，天然安全，故不扫。
const MODULE_LEVEL_PROMISE = /^(?:export\s+)?(?:let|const|var)\s+\w+\s*[:=][^;]*\bPromise\b/;
// 函数类型返回 Promise 并不代表变量本身是 promise（如 `const f: () => Promise<void>`）。
const FUNCTION_TYPE = /:\s*(?:\([^)]*\)|[A-Za-z_$][\w$.]*)\s*=>|:\s*Function\b/;

function isModuleLevelPromise(rawLine: string): boolean {
  const code = rawLine.replace(/\/\/.*$/, ''); // 排除行尾注释里提到的 Promise
  if (FUNCTION_TYPE.test(code)) return false;
  return MODULE_LEVEL_PROMISE.test(code);
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('模块级 Promise 的识别规则（自检）', () => {
  const violated = [
    'let dbInitPromise: Promise<void> | null = null;',
    'const p: A | Promise<B> = x;',
    'const hmacKeyCache = new Map<string, Promise<CryptoKey>>();',
    'export const cached = Promise.resolve(1);',
  ];
  const allowed = [
    'let tracking = false;',
    'const handler: () => Promise<void> = async () => {};',
    'const state: PromiseState = "idle"; // 类型名含 Promise 但不共享 promise',
    '  const local: Promise<void> = f(); // 缩进 = 在函数内',
  ];

  for (const line of violated) assert.equal(isModuleLevelPromise(line), true, line);
  for (const line of allowed) assert.equal(isModuleLevelPromise(line), false, line);
});

test('src/ 下不得有模块级（跨请求共享）的 Promise 变量', () => {
  const offenders: string[] = [];

  for (const file of collectTsFiles(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!isModuleLevelPromise(line)) return;
      const rel = path.relative(import.meta.dirname, file);
      offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    '模块级 Promise 会跨请求共享，创建者结束后永不 settle。' +
      '改成只存状态（布尔/枚举 + 时间戳），在当前请求里轮询：\n' + offenders.join('\n')
  );
});

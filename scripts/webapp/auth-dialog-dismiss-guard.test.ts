// 关键认证弹窗的「防误关」护栏（源码文本抽取，无 DOM 依赖）。
//
// `ConfirmDialog` 默认允许点空白 / 按 Esc 关闭 —— 对普通确认框是便利，对**要输验证码 /
// 主密码**的弹窗就是隐患：一次误点丢掉弹窗，用户得从头再走一遍（邮件 2FA 还会白烧一枚码）。
//
// 规则：弹窗里出现密码输入 / 验证码输入时，必须显式写 `dismissable=`，且不能是 `true`。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WEBAPP_SRC = path.join(REPO_ROOT, 'webapp', 'src');

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.tsx$/.test(entry.name)) files.push(full);
  }
  return files;
}

interface CredentialDialog {
  file: string;
  line: number;
  dismissable: string | null;
}

/**
 * 取出 `<ConfirmDialog` 的**开标签**。
 *
 * 不能简单地 `indexOf('>')`：`title` 里的 JSX（如 `<span>…</span>`）会提前截断，
 * 于是 `dismissable` 被当成「没写」——护栏会假报，也可能假过。
 * 这里只数字面的 `{}` 嵌套深度（括号内的 `>` 一律不算开标签结尾）。
 */
function openingTagOf(block: string): string {
  let depth = 0;
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return block.slice(0, index + 1);
  }
  return block;
}

/** 弹窗内是否有凭据类输入（密码 / 一次性验证码）。按**输入框属性**判定，不看变量名。 */
function hasCredentialInput(block: string): boolean {
  return block.includes('type="password"') || block.includes('autoComplete="one-time-code"');
}

function collectCredentialDialogs(): CredentialDialog[] {
  const found: CredentialDialog[] = [];
  for (const file of listSourceFiles(WEBAPP_SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    const starts = [...source.matchAll(/<ConfirmDialog/g)].map((match) => match.index!);
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      const end = index + 1 < starts.length ? starts[index + 1] : Math.min(source.length, start + 6000);
      const block = source.slice(start, Math.min(end, start + 6000));
      if (!hasCredentialInput(block)) continue;
      const openTag = openingTagOf(block);
      const match = openTag.match(/dismissable=\{([^}]*)\}/);
      found.push({
        file: path.relative(REPO_ROOT, file),
        line: source.slice(0, start).split('\n').length,
        dismissable: match ? match[1].trim() : null,
      });
    }
  }
  return found;
}

test('护栏自检：能扫到足够多的凭据弹窗（写法变了要跟着改，别静默扫成 0 条）', () => {
  const dialogs = collectCredentialDialogs();
  assert.ok(dialogs.length >= 14, `只扫到 ${dialogs.length} 个含凭据输入的弹窗，扫描逻辑可能已失效`);
});

test('含密码 / 验证码输入的弹窗不得被「点空白 / Esc」关掉', () => {
  const offenders = collectCredentialDialogs()
    .filter((dialog) => dialog.dismissable === null || dialog.dismissable === 'true')
    .map((dialog) => `${dialog.file}:${dialog.line}（dismissable=${dialog.dismissable ?? '未设置'}）`);
  assert.deepEqual(
    offenders,
    [],
    '这些弹窗需要 dismissable={false}（或引用「是否需要主密码」的同一标志），否则误点空白就会丢掉弹窗'
  );
});

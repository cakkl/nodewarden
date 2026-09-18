// 「把异常原文回给客户端」的源码护栏
//
// 背景（docs/TODO.md 第 4 条）：后端大量使用
//   catch (error) { return errorResponse(error.message, 500); }
// 这个模式。**今天**是安全的 —— 逐条审计下来，这些消息要么是刻意给用户看的业务文案
// （正是前端 i18n 映射表覆盖的那些），要么只插值 HTTP 状态码 / 存档内的业务标识，
// 没有主机名、路径或堆栈。但它**默认不安全**：将来只要有人在 catch 里包一层低层调用
// （D1 / WebCrypto / fetch），error.message 就可能变成
//   `D1_ERROR: no such table: users`、`TypeError: fetch failed`（含 host:port）
// 然后直接回给客户端，而**没有任何测试会红**。
//
// 本文件把这条不变量钉住：**消息实参要么是可静态证明"固定文本"的形状，要么必须显式登记**。
//
// 算安全的形状（都是静态可证，不是命名约定）：
//   ① 字符串字面量；
//   ② 模板里只有数学运算 —— `${Math.floor(x / 1024)}` 这类，Math.* 的返回值一定是 number；
//   ③ 三元的两个分支都是字面量 —— 条件只是判断，不会回给客户端；
//   ④ 同一个文件里被声明为 `const NAME = '<字面量>'` 的常量（判定的是**声明**）。
// 其余一切（error.message、变量、函数调用、拼接、未核实常量）⇒ 必须登记，并写明理由。
// 新增一处动态来源 ⇒ 强制一次人工判断；登记项失效或数量对不上 ⇒ 测试红，
// 避免白名单腐烂成"什么都放行"。
// 零运行时改动 —— 纯静态扫描。
//
// 运行方式：npm run test:error-message-guard
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * 会把**第一个实参**原样写进 JSON 响应体（error / error_description / ErrorModel.Message）
 * 的助手函数。identityErrorResponse 同样写这三个字段，所以一并纳入。
 */
const RESPONSE_HELPERS = ['errorResponse', 'unsupportedResponse', 'identityErrorResponse', 'badRequest'];

/** 只有数学运算能出现在模板插值里 —— `${Math.max(a, b)}` 这类是数字，不是文本 */
const NUMERIC_BUILTINS = new Set(['Math', 'Number', 'Infinity', 'NaN']);

/**
 * 取出 `callee(第一个实参)` 的原文。
 *
 * 为什么不用正则一把梭：实参里可能嵌套括号、逗号、对象字面量与带引号的字符串
 * （例如 `errorResponse(\`Maximum size is ${MB}MB\`, 413)`）。所以这里做一个小扫描器：
 * 跟踪括号深度、跳过字符串与转义，在深度 0 处的逗号或配对的 `)` 停下。
 */
function findMessageArguments(source: string, callees: string[]): Array<{ line: number; callee: string; argument: string }> {
  const found: Array<{ line: number; callee: string; argument: string }> = [];
  const lineAt = (index: number) => source.slice(0, index).split('\n').length;

  for (const callee of callees) {
    const pattern = new RegExp(`(^|[^\\w$.])${callee}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      // 跳过函数**声明**：`function badRequest(message: string, …)` 里的 `(` 不是调用。
      // 不跳的话会多出一条 "message" 假阳性，还会逼着登记表去登记一个并不存在的调用点。
      const nameStart = match.index + match[1].length;
      if (/function\s+$/.test(source.slice(Math.max(0, nameStart - 16), nameStart))) continue;
      const openIndex = match.index + match[0].length - 1;
      let depth = 0;
      let quote: string | null = null;
      let argument = '';
      for (let i = openIndex; i < source.length; i += 1) {
        const char = source[i];
        if (quote) {
          argument += char;
          if (char === '\\') {
            argument += source[i + 1] ?? '';
            i += 1;
            continue;
          }
          if (char === quote) quote = null;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          argument += char;
          continue;
        }
        if (char === '(' || char === '[' || char === '{') {
          depth += 1;
          if (depth > 1) argument += char;
          continue;
        }
        if (char === ')' || char === ']' || char === '}') {
          depth -= 1;
          if (depth === 0) break;
          argument += char;
          continue;
        }
        if (char === ',' && depth === 1) break;
        if (depth >= 1) argument += char;
      }
      found.push({ line: lineAt(openIndex), callee, argument: argument.trim() });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

/** 字符串字面量（不含插值）：这段文本在源码里就是固定的 */
function isMessageLiteral(argument: string): boolean {
  const trimmed = argument.trim();
  if (/^'(?:[^'\\]|\\.)*'$/s.test(trimmed)) return true;
  if (/^"(?:[^"\\]|\\.)*"$/s.test(trimmed)) return true;
  if (/^`(?:[^`\\$]|\\.)*`$/s.test(trimmed)) return true;
  return false;
}

/** 同一个文件里 `const NAME = '<字面量>'` 形式的模块级常量（值本身就是固定文案） */
function declaredLiteralConstants(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) names.add(match[1]);
  return names;
}

/**
 * 从 import 的目标模块里核实跨文件常量：`import { A } from './x'` ⇒ 去 x.ts 里找
 * `const A = '<字面量>'`。解析不到目标模块 / 目标模块里不是字面量（或同一个名字被
 * 重新赋过值）⇒ 不算安全，宁可让它落到登记表里。
 */
function importedLiteralConstants(source: string, filePath: string): Set<string> {
  const names = new Set<string>();
  if (!filePath) return names;
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const specifier = match[2].endsWith('.ts') ? match[2] : `${match[2]}.ts`;
    let targetSource: string;
    try {
      targetSource = readFileSync(path.resolve(path.dirname(filePath), specifier), 'utf8');
    } catch {
      continue;
    }
    const targetConstants = declaredLiteralConstants(targetSource);
    for (const imported of match[1].split(',')) {
      const [exported, local = exported] = imported.trim().split(/\s+as\s+/);
      if (exported && targetConstants.has(exported.trim())) names.add(local.trim());
    }
  }
  return names;
}

/**
 * 把 `Math.floor(…)` / `Number.isInteger(…)` 这类调用整段替换成 `0`。
 * 依据：Math.* 与 Number.* 的返回值一定是 number，拼不出表名或路径。
 */
function stripNumericCalls(expression: string): string {
  let result = expression;
  for (;;) {
    const match = /\b(?:Math|Number)\.\w+\s*\(/.exec(result);
    if (!match) return result;
    let depth = 0;
    let end = -1;
    let quote: string | null = null;
    for (let i = match.index + match[0].length - 1; i < result.length; i += 1) {
      const char = result[i];
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
    if (end === -1) return result;
    result = `${result.slice(0, match.index)}0${result.slice(end + 1)}`;
  }
}

/** `${…}` 里只允许数字运算：出现字符串，或出现未经核实的变量，就算可能带出文本 */
function isNumericInterpolation(expression: string, constants: Set<string>): boolean {
  if (/['"`]/.test(expression)) return false;
  // 属性名不是变量（`LIMITS.device.max` ⇒ 只留 `LIMITS`），再摘掉数学调用
  const rest = stripNumericCalls(expression).replace(/\.[A-Za-z_$][\w$]*/g, '');
  const identifiers = rest.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return identifiers.every((name) => NUMERIC_BUILTINS.has(name) || /^[a-z]$/.test(name) || constants.has(name));
}

/** 取出模板字符串里的 `${…}` 表达式；不是完整模板时返回 null */
function templateInterpolations(argument: string): string[] | null {
  if (!argument.startsWith('`') || !argument.endsWith('`')) return null;
  const interpolations: string[] = [];
  for (let i = 1; i < argument.length - 1; i += 1) {
    const char = argument[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char !== '$' || argument[i + 1] !== '{') continue;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let j = i + 1; j < argument.length; j += 1) {
      const inner = argument[j];
      if (quote) {
        if (inner === '\\') j += 1;
        else if (inner === quote) quote = null;
        continue;
      }
      if (inner === "'" || inner === '"' || inner === '`') {
        quote = inner;
        continue;
      }
      if (inner === '{') depth += 1;
      else if (inner === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) return null;
    interpolations.push(argument.slice(i + 2, end));
    i = end;
  }
  return interpolations;
}

/** 找顶层三元表达式的第一个 `?`（跳过 `??` 与 `?.`） */
function topLevelIndexOfTernary(argument: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < argument.length; i += 1) {
    const char = argument[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === '?' && depth === 0 && argument[i + 1] !== '?' && argument[i + 1] !== '.') return i;
  }
  return -1;
}

/** 把 `cond ? a : b` 拆成两个分支（嵌套三元按层级配对方括号外的冒号） */
function splitTopLevelTernary(argument: string): { whenTrue: string; whenFalse: string } | null {
  const ternaryIndex = topLevelIndexOfTernary(argument);
  if (ternaryIndex === -1) return null;
  let depth = 0;
  let nested = 0;
  let quote: string | null = null;
  for (let i = ternaryIndex + 1; i < argument.length; i += 1) {
    const char = argument[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === '?' && argument[i + 1] !== '?' && argument[i + 1] !== '.') {
      nested += 1;
      continue;
    }
    if (char !== ':') continue;
    if (nested === 0) {
      return { whenTrue: argument.slice(ternaryIndex + 1, i).trim(), whenFalse: argument.slice(i + 1).trim() };
    }
    nested -= 1;
  }
  return null;
}

/** 三元的两个分支都是字面量（允许继续嵌套三元）—— 条件本身不会回给客户端 */
function isLiteralTernary(argument: string): boolean {
  const split = splitTopLevelTernary(argument.trim());
  if (!split) return false;
  const isLiteralBranch = (branch: string) => isMessageLiteral(branch) || isLiteralTernary(branch);
  return isLiteralBranch(split.whenTrue) && isLiteralBranch(split.whenFalse);
}

type MessageVerdict = { safe: true; reason: string } | { safe: false };

/**
 * 判定某个消息实参是否算"可静态证明的固定文本"。
 * 只有开头的四种形状算安全，其余一律落到登记表里，强制一次人工判断。
 */
function classifyMessageArgument(argument: string, source: string, filePath = ''): MessageVerdict {
  const trimmed = argument.trim();
  if (isMessageLiteral(trimmed)) return { safe: true, reason: '字面量' };
  const constants = new Set([...declaredLiteralConstants(source), ...importedLiteralConstants(source, filePath)]);
  if (trimmed.startsWith('`')) {
    const interpolations = templateInterpolations(trimmed);
    if (interpolations && interpolations.every((expr) => isNumericInterpolation(expr, constants))) {
      return { safe: true, reason: '模板插值只含数学运算' };
    }
    return { safe: false };
  }
  if (isLiteralTernary(trimmed)) return { safe: true, reason: '三元分支均为字面量' };
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && constants.has(trimmed)) {
    return { safe: true, reason: `常量 ${trimmed} 已核实为字符串字面量（同文件或 import 目标模块里）` };
  }
  return { safe: false };
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath ?? dir, entry.name))
    .filter((file) => !file.endsWith('.test.ts'));
}

// ---------------------------------------------------------------- 扫描器自检
// 护栏自身的正确性必须先被钉住：解析器一旦写错（例如把嵌套括号吃掉、把模板字符串
// 误判成字面量），下面的白名单断言就会**静默放行**，护栏等于不存在。
test('扫描器自检：字面量 / 模板插值 / 变量 / 嵌套括号与转义', () => {
  const fixture = [
    "errorResponse('Simple message', 400);",
    'errorResponse("Double quoted", 400);',
    'errorResponse(`No interpolation here`, 400);',
    'errorResponse(`File too large. Maximum size is ${mb}MB`, 413);',
    'errorResponse(message, 500);',
    'errorResponse(buildMessage(a, b), 500);',
    "errorResponse('Has a ) paren and , comma', 400);",
    "errorResponse(`With ${nested({ a: 1, b: 'x,y' })} inside`, 400);",
    'badRequest(error instanceof Error ? error.message : "x", 500);',
    'notAHelper(`should be ignored`, 400);',
  ].join('\n');

  const sites = findMessageArguments(fixture, RESPONSE_HELPERS);
  assert.deepEqual(
    sites.map((site) => site.argument),
    [
      "'Simple message'",
      '"Double quoted"',
      '`No interpolation here`',
      '`File too large. Maximum size is ${mb}MB`',
      'message',
      'buildMessage(a, b)',
      "'Has a ) paren and , comma'",
      '`With ${nested({ a: 1, b: \'x,y\' })} inside`',
      'error instanceof Error ? error.message : "x"',
    ],
    '扫描器必须逐字取出第一个实参，且不把非同名前缀的调用算进来'
  );
  assert.equal(classifyMessageArgument("'Simple message'", '').safe, true);
  assert.equal(classifyMessageArgument('`No interpolation here`', '').safe, true);
  assert.equal(classifyMessageArgument('message', '').safe, false);
  assert.equal(classifyMessageArgument('error instanceof Error ? error.message : "x"', '').safe, false);
});

// ---------------------------------------------------------------- 判定器自检
test('判定器自检：安全形状（数学插值 / 字面量三元 / 已核实常量）与动态来源的分界', () => {
  const fixture = [
    'const LIMITS = { device: { maxBulkIdentifiers: 200 } };',
    "const SEND_INACCESSIBLE_MSG = 'Send does not exist or is no longer available';",
    "const KDF_MESSAGE =\n  'PBKDF2 iterations must be at least 100000';",
    'const NOT_A_LITERAL = `boom ${error.message}`;',
  ].join('\n');
  const verdict = (argument: string) => classifyMessageArgument(argument, fixture).safe;

  // 安全：插值只做数学运算或计数
  assert.equal(verdict('`File too large. Maximum size is ${Math.floor(maxFileSize / (1024 * 1024))}MB`'), true);
  assert.equal(verdict('`Try again in ${Math.ceil((check.retryAfterSeconds || 60) / 60)} minutes`'), true);
  assert.equal(verdict('`Cipher ${i + 1} is invalid`'), true);
  assert.equal(verdict('`Maximum is ${Math.floor(MAX_BACKUP_ARCHIVE_BYTES / (1024 * 1024))}MB`'), true);
  assert.equal(verdict('`Cipher ${i + 1}: ${compatibilityError}`'), false, '插值里的变量必须登记');
  assert.equal(verdict('`Attachment blob missing for ${blobName}`'), false);
  assert.equal(verdict('`boom ${error.message}`'), false, '异常原文绝不允许');
  assert.equal(verdict('`max ${LIMITS.device.maxBulkIdentifiers}`'), false, '属性取值链无法证明是数字');
  assert.equal(verdict('`max ${MAX_BACKUP_ARCHIVE_BYTES}`'), false, '没被数学运算包裹的常量无法证明是数字');
  assert.equal(verdict('`${lines.join(", ")}`'), false, '插值里出现字符串字面量（可能是拼接出来的文本）');

  // 安全：三元的两个分支都是字面量（条件是判断，不是文本）
  assert.equal(verdict("unsafe === 'missing' ? 'JWT_SECRET is not set' : 'JWT_SECRET must be at least 32 characters'"), true);
  assert.equal(verdict("initialized?.credentials\n          ? 'already configured'\n          : 'unable to initialize'"), true);
  assert.equal(verdict("ok ? 'fine' : failureReason"), false, '分支里有变量必须登记');

  // 安全：常量在**同一文件**里被声明为字符串字面量（判定声明，不是命名约定）
  assert.equal(verdict('SEND_INACCESSIBLE_MSG'), true);
  assert.equal(verdict('KDF_MESSAGE'), true, '跨行声明的字面量常量同样算');
  assert.equal(verdict('NOT_A_LITERAL'), false, '同名常量本身是模板拼出来的 ⇒ 不安全');
  assert.equal(verdict('SOME_OTHER_FILE_CONSTANT'), false, '别的文件里的常量拿不到声明 ⇒ 必须登记');

  // 跨文件常量：只有去 import 指向的模块里核实到字面量声明才算安全
  const publicPath = path.join(SRC_ROOT, 'handlers/sends-public.ts');
  assert.equal(
    classifyMessageArgument('SEND_INACCESSIBLE_MSG', readFileSync(publicPath, 'utf8'), publicPath).safe,
    true,
    'sends-public.ts 从 sends-shared.ts import 的常量应当在目标模块里核实'
  );
  assert.equal(
    classifyMessageArgument(
      'SEND_INACCESSIBLE_MSG',
      "import { SEND_INACCESSIBLE_MSG } from './not-a-real-module';",
      publicPath
    ).safe,
    false,
    '解析不到目标模块时 fail-closed'
  );

  // 不安全：拼接 / join / 序列化
  assert.equal(verdict("'prefix: ' + value"), false);
  assert.equal(verdict('lines.join(", ")'), false);
  assert.equal(verdict('JSON.stringify(payload)'), false);
});

// ---------------------------------------------------------------- 登记表
interface RegisteredDynamicMessage {
  /** `文件 :: 第一个实参原文`（空白压平成单空格） */
  site: string;
  /** 期望出现的次数：少一处 / 多一处都会红，逼着人重看一遍 */
  count: number;
  /** 为什么这段文本不可能带出内部信息 */
  reason: string;
}

/**
 * 允许的**动态**消息来源。
 *
 * 每条都必须写清理由。新增条目 = 一次人工判断；条目失效或数量对不上 = 测试红，
 * 防止登记表腐烂成"什么都放行"。
 */
const REGISTERED_DYNAMIC_MESSAGES: RegisteredDynamicMessage[] = [
  // ── 管理端备份链路：刻意保留的可诊断性 ──────────────────────────────
  // 远端地址是管理员自己填的 WebDAV / S3，失败原文（真机验收见到的
  // `WebDAV upload timed out after 30000 ms`）正是前端 i18n 映射表覆盖的业务文案，
  // 也是排障的唯一线索；这些接口仅管理员可达，文案里不含堆栈与凭据。
  {
    site: "src/durable/backup-transfer-runner.ts :: error instanceof Error ? error.message : 'Backup run failed'",
    count: 1,
    reason: 'DO 内备份任务失败原文，经管理端备份中心回显',
  },
  {
    site: "src/durable/backup-transfer-runner.ts :: error instanceof Error ? error.message : 'Scheduled backup failed'",
    count: 1,
    reason: '同上：定时备份失败原文（管理端可见）',
  },
  {
    site: "src/durable/backup-transfer-runner.ts :: error instanceof Error ? error.message : 'Remote backup restore failed'",
    count: 1,
    reason: '同上：远端恢复失败原文',
  },
  {
    site: "src/durable/backup-transfer-runner.ts :: error instanceof Error ? error.message : 'Backup transfer request failed'",
    count: 1,
    reason: '同上：备份传输请求失败原文',
  },
  {
    site: 'src/durable/backup-transfer-runner.ts :: `Attachment blob missing for ${blobName}`',
    count: 1,
    reason: 'blobName 是管理端备份流程自己传进来的 R2 对象名，不是异常原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Backup settings could not be loaded'",
    count: 1,
    reason: '管理端备份设置读取失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Backup settings are invalid'",
    count: 1,
    reason: '管理端备份设置校验失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Backup settings repair state could not be loaded'",
    count: 1,
    reason: '管理端备份修复状态读取失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Backup settings repair payload is invalid'",
    count: 1,
    reason: '管理端备份修复入参校验失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Backup run failed'",
    count: 1,
    reason: '管理端手动备份失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Remote backup listing failed'",
    count: 1,
    reason: '远端备份列表失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Remote backup download failed'",
    count: 1,
    reason: '远端备份下载失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Remote backup integrity inspection failed'",
    count: 1,
    reason: '远端备份完整性检查失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Remote backup delete failed'",
    count: 1,
    reason: '远端备份删除失败原文',
  },
  {
    site: "src/handlers/backup.ts :: error instanceof Error ? error.message : 'Backup attachment download failed'",
    count: 1,
    reason: '备份附件下载失败原文',
  },
  {
    site: 'src/handlers/backup.ts :: message',
    count: 3,
    reason: '1185 / 1254 / 1368 三处 recovery/import/export 的失败原文（同上，管理端）',
  },
  // ── 传参式文案 / 校验函数返回值：逐条核实过只返回固定文案 ──────────────
  {
    site: 'src/utils/response.ts :: message',
    count: 1,
    reason: 'unsupportedResponse 的透传参数；所有调用点都传字面量（调用点同样被本护栏扫描）',
  },
  {
    site: 'src/handlers/accounts.ts :: kdfErr',
    count: 1,
    reason: 'validateKdfParams 的返回值，逐条核实只返回固定文案（KDF type must be … 等）',
  },
  {
    site: 'src/handlers/ciphers.ts :: compatibilityError',
    count: 2,
    reason: 'validateCipherEncryptedFieldsForCompatibility 的返回值，逐条核实只返回固定文案（字段名取自代码内固定列表）',
  },
  {
    site: 'src/handlers/import.ts :: `Cipher ${i + 1}: ${compatibilityError}`',
    count: 1,
    reason: '同上 + 第 i 个条目序号（数字）',
  },
  {
    site: 'src/handlers/sends-shared.ts :: sendPasswordLockMessage(retryAfterSeconds)',
    count: 1,
    reason: '文案内只插值 Math.ceil(retryAfterSeconds / 60)',
  },
  {
    site: 'src/utils/direct-upload.ts :: tooLargeMessage',
    count: 3,
    reason: '文案由调用方以字面量传入（attachments.ts / sends-private.ts 调用点均是字面量），函数内只透传',
  },
  {
    site: 'src/utils/direct-upload.ts :: missingBodyMessage',
    count: 2,
    reason: '同上（默认值本身就是字面量，真实文案来自调用方）',
  },
  {
    site: 'src/utils/direct-upload.ts :: contentLengthRequiredMessage',
    count: 1,
    reason: '同上（默认值本身就是字面量，真实文案来自调用方）',
  },
  {
    site: "src/utils/direct-upload.ts :: fileNameMismatchMessage || 'File name does not match.'",
    count: 1,
    reason: '同上（默认值本身就是字面量，真实文案来自调用方）',
  },
  {
    site: "src/utils/direct-upload.ts :: sizeMismatchMessage || 'File size does not match.'",
    count: 2,
    reason: '同上（默认值本身就是字面量，真实文案来自调用方）',
  },
  // ── WebAuthn：异常原文来自本仓库自己的固定文案 ──────────────────────
  {
    site: "src/handlers/account-passkeys.ts :: error instanceof Error ? error.message : 'Passkey assertion failed'",
    count: 1,
    reason: '该文件里所有 throw new Error(…) 都是固定文案（Invalid passkey assertion response / Passkey assertion could not be verified 等）',
  },
  {
    site: 'src/handlers/account-passkeys.ts :: `Passkey setup failed while ${passkeySetupStageMessage(stage)}`',
    count: 1,
    reason: 'passkeySetupStageMessage 逐条核实只返回固定阶段文案（verifying master password 等）',
  },
  // ── 数值上限：静态扫描证明不了"这是数字"，所以登记下来 ─────────────────
  {
    site: 'src/handlers/devices.ts :: `Too many devices in one request (max ${LIMITS.device.maxBulkIdentifiers})`',
    count: 2,
    reason: 'LIMITS.device.maxBulkIdentifiers 是数值上限（src/config/limits.ts 里的 number）',
  },
  {
    site: 'src/handlers/import.ts :: `Import exceeds maximum of ${LIMITS.performance.importItemLimit} items`',
    count: 1,
    reason: 'LIMITS.performance.importItemLimit 是数值上限（number）',
  },
  // ── identity 端点：透传参数，唯一调用点传字面量 ───────────────────────
  {
    site: 'src/handlers/accounts.ts :: message',
    count: 1,
    reason: "第 259–262 行 `const message = unsafe === 'missing' ? 'JWT_SECRET is not set' : 'JWT_SECRET must be at least 32 characters'`，两个分支都是字面量（未做局部变量解析，所以在这里登记）",
  },
  {
    site: 'src/handlers/identity.ts :: message',
    count: 1,
    reason: 'recordFailedLoginAndBuildResponse 的透传参数；唯一调用点传字面量（Username or password is incorrect. Try again）',
  },
  {
    site: 'src/handlers/identity.ts :: `Rate limit exceeded. Try again in ${sendAccessLimit.retryAfterSeconds} seconds.`',
    count: 1,
    reason: 'sendAccessLimit.retryAfterSeconds 是限速服务算出来的秒数（number）',
  },
  {
    site: 'src/handlers/identity.ts :: `Rate limit exceeded. Try again in ${retryAfter} seconds.`',
    count: 1,
    reason: 'retryAfter 来自 Math.max(1, rejected.retryAfterSeconds || 1)，是秒数（number）',
  },
];

/** `文件 :: 实参原文` 作为键（空白压平，避免换行影响匹配） */
function dynamicMessageKey(relativeFile: string, argument: string): string {
  return `${relativeFile} :: ${argument.replace(/\s+/g, ' ').trim()}`;
}

test('护栏：响应助手的消息实参只能是字面量或已登记的动态来源', () => {
  const found = new Map<string, string[]>();

  for (const file of collectSourceFiles(SRC_ROOT)) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const source = readFileSync(file, 'utf8');
    for (const site of findMessageArguments(source, RESPONSE_HELPERS)) {
      if (classifyMessageArgument(site.argument, source, file).safe) continue;
      const key = dynamicMessageKey(relative, site.argument);
      const locations = found.get(key) ?? [];
      locations.push(`${relative}:${site.line}  ${site.callee}(${site.argument}, …)`);
      found.set(key, locations);
    }
  }

  const registered = new Map<string, number>();
  for (const entry of REGISTERED_DYNAMIC_MESSAGES) {
    registered.set(entry.site, (registered.get(entry.site) ?? 0) + entry.count);
  }

  const unregistered: string[] = [];
  for (const [key, locations] of found) {
    const allowed = registered.get(key) ?? 0;
    if (locations.length > allowed) unregistered.push(...locations.slice(allowed));
  }
  unregistered.sort();
  assert.deepEqual(
    unregistered,
    [],
    `发现未登记的动态错误消息（${unregistered.length} 处）。\n`
      + '这些文本会被原样回给客户端（error / error_description / ErrorModel.Message 三个字段）。\n'
      + '若它来自 catch 到的异常（error.message / String(error)），就可能泄露表名、路径或内网地址。\n'
      + '处理方式：① 改成固定业务文案；② 或在本文件的 REGISTERED_DYNAMIC_MESSAGES 登记并写明理由。\n\n'
      + unregistered.join('\n')
  );

  // 反方向：登记项失效、或数量对不上，都必须红 —— 否则它会默默放行未来的同名变量
  const stale: string[] = [];
  for (const [key, count] of registered) {
    const actual = found.get(key)?.length ?? 0;
    if (actual !== count) stale.push(`${key}（登记 ${count} 处，实际 ${actual} 处）`);
  }
  stale.sort();
  assert.deepEqual(stale, [], `登记表与代码对不上，请更新 REGISTERED_DYNAMIC_MESSAGES：\n${stale.join('\n')}`);
});

test('护栏自检：扫描到足够多的调用点（API 改名/重构时这条会先红，而不是静默扫到 0 处）', () => {
  let total = 0;
  for (const file of collectSourceFiles(SRC_ROOT)) {
    total += findMessageArguments(readFileSync(file, 'utf8'), RESPONSE_HELPERS).length;
  }
  // 实测 547 处（2026-09 全量扫描）。留一点余量，但任何「扫描器失效 ⇒ 扫到 0 处」
  // 的情况都会先撞上这条断言，而不是让下面那条护栏变成空转。
  assert.ok(total >= 500, `期望扫到 500+ 处错误响应调用点，实际只有 ${total} 处 —— 护栏可能已失效`);
});

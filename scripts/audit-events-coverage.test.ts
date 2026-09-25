// 审计事件的**覆盖护栏 + 行为验收**。
//
// 防的是两类**静默失效** —— 不报错、也不会让既有测试变红，只是日志中心里少了东西：
//   ① **元数据被丢弃**：`sanitizeMetadata` 有白名单 + 敏感键正则两道关卡，键名不合规就被静默丢掉
//      （如含 `key` / `private` / `password` 的名字），那条日志在界面上只剩动作名。
//   ② **动作没有语言包标签**：缺键不会崩（`LogCenterPage` 会把动作名 humanize 成英文兜底），
//      所以只能靠断言发现。
//
// 三组断言：
//   ① 源码里出现的每个动作，在**每个**语言包都有标签（动作标签，或 `auth.refresh.failed.*` 的 reason 标签）；
//   ② 源码里出现的每个元数据键都能通过 `isAuditableMetadataKey`（= 不会被静默丢弃）；
//   ③ 行为验收：API 密钥创建/轮换、主密码修改、账户资料修改
//      真的落进 `audit_logs`，且元数据**落库后依然存在**（②的端到端版本）。
//
// 运行方式：npm run test:audit-events
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

import {
  handleChangePassword,
  handleGetApiKey,
  handleRotateApiKey,
  handleSetKeys,
  handleUpdateProfile,
} from '../src/handlers/accounts';
import { isAuditableMetadataKey } from '../src/services/audit-events';
import { AuthService } from '../src/services/auth';
import type { Env } from '../src/types';
import { createSchemaDatabase, enc, insertUser, resetProcessScopedStatics, TEST_JWT_SECRET } from './lib/test-harness';

const require = createRequire(import.meta.url);
const { localeFiles, readLocale } = require('./i18n-utils.cjs') as {
  localeFiles: Array<[string, string, string, string]>;
  readLocale: (fileName: string, variableName: string) => Record<string, string>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
/** 审计动作的形状：小写点分标识符 */
const ACTION_SHAPE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
/** `auth.refresh.failed.<reason>` 走的是「动作 + reason」两段标签，不是单个动作标签 */
const REFRESH_FAILED_PREFIX = 'auth.refresh.failed.';
/** 只扫生产代码；`scripts/` 下的测试自身会引用动作名，混进来会互相干扰 */
const SCAN_ROOTS = ['src', 'shared', 'webapp/src'];

/** 与 `webapp/src/components/LogCenterPage.tsx` 的 `keyFor()` 保持一致 */
function labelKeyFor(prefix: string, value: string): string {
  return prefix
    + value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(rel, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** 取 `(` 之后到配对 `)` 之前的实参原文（跳过字符串与嵌套括号） */
function callArguments(source: string, openParenIndex: number): string {
  let depth = 1;
  let quote: string | null = null;
  for (let i = openParenIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return '';
}

/** 按顶层逗号切分实参 */
function splitTopLevelArgs(argText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < argText.length; i += 1) {
    const ch = argText[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += argText[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * 从源码里收集审计动作。
 *
 * 三类来源都要顾到，否则会漏：① `write*Audit*(…)` 里作为独立字符串实参传入的
 * （多个 handler 用包装函数把 action 作为参数转交）；② `action: '…'` 与 `action: cond ? 'a' : 'b'`；
 * ③ `let auditAction = '…'`（API 密钥那条路径就是这么选的）。
 */
function collectActionsFromSource(): Map<string, string> {
  const found = new Map<string, string>();
  const record = (action: string, where: string): void => {
    if (!found.has(action)) found.set(action, where);
  };

  for (const rel of SCAN_ROOTS.flatMap((root) => collectSourceFiles(root))) {
    const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const lineAt = (index: number): number => source.slice(0, index).split('\n').length;

    for (const match of source.matchAll(/\b(write\w*Audit\w*)\s*\(/g)) {
      const where = `${rel}:${lineAt(match.index)}`;
      for (const arg of splitTopLevelArgs(callArguments(source, match.index + match[0].length - 1))) {
        const literal = /^'([^']*)'$/.exec(arg);
        if (literal && ACTION_SHAPE.test(literal[1])) record(literal[1], where);
      }
    }

    for (const match of source.matchAll(/\baction:\s*([^\n]+(?:\n\s*[?:][^\n]+)*)/g)) {
      const where = `${rel}:${lineAt(match.index)}`;
      for (const literal of match[1].matchAll(/'([^']*)'/g)) {
        if (ACTION_SHAPE.test(literal[1])) record(literal[1], where);
      }
    }

    for (const match of source.matchAll(/auditAction\s*=\s*([^;]+);/g)) {
      const where = `${rel}:${lineAt(match.index)}`;
      for (const literal of match[1].matchAll(/'([^']*)'/g)) {
        if (ACTION_SHAPE.test(literal[1])) record(literal[1], where);
      }
    }
  }
  return found;
}

/**
 * 从源码里收集 `metadata: { … }` 的顶层键。
 *
 * 只扫确实会写审计的文件，且只取 `标识符:` 形式 —— 展开（`...auditRequestMetadata(request)`）
 * 不会被当成键。
 */
function collectMetadataKeysFromSource(): Map<string, string> {
  const found = new Map<string, string>();

  for (const rel of SCAN_ROOTS.flatMap((root) => collectSourceFiles(root))) {
    const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    if (!/\bwrite\w*Audit\w*\s*\(/.test(source)) continue;

    for (const match of source.matchAll(/\bmetadata:\s*\{([^}]*)/g)) {
      const where = `${rel}:${source.slice(0, match.index).split('\n').length}`;
      for (const key of match[1].matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g)) {
        if (!found.has(key[1])) found.set(key[1], where);
      }
    }
  }
  return found;
}

test('源码里出现的每个审计动作，在全部语言包都有标签', () => {
  const actions = collectActionsFromSource();
  assert.ok(actions.size >= 60, `应当扫到足够多的动作（实际 ${actions.size}）——过少说明扫描逻辑失效`);

  const missing: string[] = [];
  for (const [locale, fileName, variableName] of localeFiles) {
    const table = readLocale(fileName, variableName);
    for (const [action, where] of actions) {
      // `auth.refresh.failed.<reason>` 的界面文案是「动作 + reason」两段，动作标签固定是
      // `txt_log_action_auth_refresh_failed`（见 LogCenterPage 的 formatAction 前缀特判）。
      const needed = action.startsWith(REFRESH_FAILED_PREFIX)
        ? ['txt_log_action_auth_refresh_failed',
           labelKeyFor('txt_log_reason_', action.slice(REFRESH_FAILED_PREFIX.length))]
        : [labelKeyFor('txt_log_action_', action)];
      for (const key of needed) {
        if (!table[key]) missing.push(`${locale} 缺 ${key}（用于 ${action}，来源 ${where}）`);
      }
    }
  }

  assert.deepStrictEqual(missing, [], `以下语言包标签缺失（缺键不会报错，只会 humanize 成英文兜底）：\n${missing.join('\n')}`);
});

test('源码里出现的每个审计元数据键都不会被静默丢弃', () => {
  const keys = collectMetadataKeysFromSource();
  assert.ok(keys.size >= 8, `应当扫到足够多的元数据键（实际 ${keys.size}）`);

  const dropped = [...keys]
    .filter(([key]) => !isAuditableMetadataKey(key))
    .map(([key, where]) => `${key}（${where}）—— 既不在 ALLOWED_METADATA_KEYS、或键名命中敏感正则`);

  assert.deepStrictEqual(dropped, [], `以下元数据键会被 sanitizeMetadata 丢弃，日志中心只剩动作名：\n${dropped.join('\n')}`);
});

// ─────────────────── 行为验收 ───────────────────

const USER_ID = 'audit-cover-user';
const USER_EMAIL = 'audit-cover@example.test';
const CLIENT_HASH = 'client-side-hash-of-master-password';

interface AuditRow {
  action: string;
  category: string;
  level: string;
  actor_user_id: string | null;
  target_id: string | null;
  metadata: string;
}

function jsonRequest(body: unknown): Request {
  return new Request('https://vault.example.test/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAuditHarness() {
  resetProcessScopedStatics();
  const handle = await createSchemaDatabase();
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const auth = new AuthService(env);
  insertUser(handle.connection, USER_ID, {
    email: USER_EMAIL,
    masterPasswordHash: await auth.hashPasswordServer(CLIENT_HASH, USER_EMAIL),
  });
  return { handle, env };
}

/** 按动作读取落库后的审计行（含 metadata，用于验证"真的写进去了"） */
function readRows(connection: DatabaseSync, action: string): AuditRow[] {
  return connection
    .prepare('SELECT action, category, level, actor_user_id, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY created_at ASC')
    .all(action) as unknown as AuditRow[];
}

function parseMetadata(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.metadata || '{}') as Record<string, unknown>;
}

test('API 密钥：查看 / 创建 / 轮换都落进日志中心', async () => {
  const { handle, env } = await createAuditHarness();

  // 首次取密钥 = 创建
  const created = await handleGetApiKey(jsonRequest({ masterPasswordHash: CLIENT_HASH }), env, USER_ID);
  assert.equal(created.status, 200);
  const createdRows = readRows(handle.connection, 'account.api_key.create');
  assert.equal(createdRows.length, 1, '创建 API 密钥必须留下审计事件');
  assert.equal(createdRows[0].level, 'security', '创建长期凭据属于安全事件');

  // 已有密钥再取 = 仅查看（不应产生 create/rotate）
  const viewed = await handleGetApiKey(jsonRequest({ masterPasswordHash: CLIENT_HASH }), env, USER_ID);
  assert.equal(viewed.status, 200);
  assert.equal(readRows(handle.connection, 'account.api_key.view').length, 1, '查看 API 密钥必须留下审计事件');
  assert.equal(readRows(handle.connection, 'account.api_key.create').length, 1, '查看不应被记成创建');

  // 轮换
  const rotated = await handleRotateApiKey(jsonRequest({ masterPasswordHash: CLIENT_HASH }), env, USER_ID);
  assert.equal(rotated.status, 200);
  const rotatedRows = readRows(handle.connection, 'account.api_key.rotate');
  assert.equal(rotatedRows.length, 1, '轮换 API 密钥必须留下审计事件');
  assert.equal(rotatedRows[0].level, 'security');

  // 请求上下文（IP / 路径）也要真的落库 —— 它们同样过白名单，是最容易被丢的一类
  const meta = parseMetadata(rotatedRows[0]);
  assert.equal(meta.method, 'POST');
  assert.equal(meta.path, '/api/accounts');

  handle.close();
});

test('主密码修改落进日志中心，并记录账号邮箱', async () => {
  const { handle, env } = await createAuditHarness();

  const response = await handleChangePassword(jsonRequest({
    currentPasswordHash: CLIENT_HASH,
    newMasterPasswordHash: 'new-client-side-hash',
    newKey: enc('next-key'),
    masterPasswordHint: 'a hint',
  }), env, USER_ID);
  assert.equal(response.status, 200, '主密码修改应当成功');

  const rows = readRows(handle.connection, 'user.password.change');
  assert.equal(rows.length, 1, '修改主密码必须留下审计事件');
  assert.equal(rows[0].level, 'security');
  assert.equal(rows[0].actor_user_id, USER_ID);
  // 邮箱放在元数据里：改完密码后真主人可能进不去，这条是唯一的求助线索
  assert.equal(parseMetadata(rows[0]).email, USER_EMAIL);

  handle.close();
});

test('账户资料修改：变更内容必须真的落库（回归：键名含 password 会被丢弃）', async () => {
  const { handle, env } = await createAuditHarness();

  const response = await handleUpdateProfile(jsonRequest({ masterPasswordHint: 'a hint' }), env, USER_ID);
  assert.equal(response.status, 200);

  const rows = readRows(handle.connection, 'account.profile.update');
  assert.equal(rows.length, 1);
  // 回归点：`updatedMasterPasswordHint` 命中敏感正则 `password`，若不换成白名单里的键
  // 就会被丢弃，落库后 metadata 里只剩请求上下文。
  assert.equal(parseMetadata(rows[0]).changed, 'masterPasswordHint');

  handle.close();
});

test('账户密钥更新：哪几段被替换必须真的落库（回归：键名含 key/private 会被丢弃）', async () => {
  const { handle, env } = await createAuditHarness();

  const response = await handleSetKeys(jsonRequest({
    masterPasswordHash: CLIENT_HASH,
    key: enc('new-key'),
    encryptedPrivateKey: enc('new-private'),
    publicKey: enc('new-public'),
  }), env, USER_ID);
  assert.equal(response.status, 200);

  const rows = readRows(handle.connection, 'account.keys.update');
  assert.equal(rows.length, 1);
  // 回归点：`updatedKey` / `updatedPrivateKey` / `updatedPublicKey` 既不在白名单、
  // 又命中敏感正则 ⇒ 会被全部丢弃。
  assert.equal(parseMetadata(rows[0]).changed, 'key,encryptedPrivateKey,publicKey');

  handle.close();
});

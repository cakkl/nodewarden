// `scripts/ensure-kv.cjs` 的加固守卫
//
// 为什么值得测：这个脚本**会改写受版本控制的 `wrangler.kv.toml`**，而写进去的 id 决定
// 「附件写进哪个 KV 库」。它有三种**静默失败**：
//   ① 猜错命名空间（原来会退化到 `endsWith('attachments-kv')` 模糊匹配）⇒ 附件写进别的库；
//   ② 「打印成功但其实没写」（插入正则不匹配时写回原文）⇒ 下次构建又去新建，正是它要防的 10014；
//   ③ 把 id 插进**别的段**（原来要求 `binding` 行必须紧跟段头）。
// 所以下面的断言重点不是"能跑通"，而是"猜错/写错/插错时会不会响"。
//
// 运行方式：npm run test:ensure-kv
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

interface EnsureKvModule {
  BINDING: string;
  bindingBlock: (toml: string, binding?: string) => string | null;
  bindingBlockHasId: (toml: string, binding?: string) => boolean;
  expectedTitle: (toml: string) => string;
  findSimilarNamespaces: (namespaces: unknown, title: string) => Array<{ title: string; id: string }>;
  insertIdIntoBindingBlock: (toml: string, id: string, binding?: string) => string;
  parseArgs: (argv: string[]) => { id: string | null; forceNew: boolean; help: boolean };
  parseCreatedNamespaceId: (output: string) => string;
}

const ensureKv = require_(path.join(REPO_ROOT, 'scripts/ensure-kv.cjs')) as EnsureKvModule;

const ID = '0123456789abcdef0123456789abcdef';
const TOML_WITHOUT_ID = [
  'name = "nodewarden"',
  '',
  '[[d1_databases]]',
  'binding = "DB"',
  'database_name = "nodewarden-db"',
  '',
  '[[kv_namespaces]]',
  'binding = "ATTACHMENTS_KV"',
  '',
  '[[durable_objects.bindings]]',
  'name = "NOTIFICATIONS_HUB"',
  '',
].join('\n');

// ---------------------------------------------------------------- 段落识别

test('bindingBlockHasId：段内没有 id 时返回 false', () => {
  assert.equal(ensureKv.bindingBlockHasId(TOML_WITHOUT_ID), false);
});

test('bindingBlockHasId：段内有 id 时为 true；同一个 binding 名在别的段不算', () => {
  const withId = TOML_WITHOUT_ID.replace('binding = "ATTACHMENTS_KV"', `binding = "ATTACHMENTS_KV"\nid = "${ID}"`);
  assert.equal(ensureKv.bindingBlockHasId(withId), true);
  // `DB` 这个 binding 只出现在 [[d1_databases]] 里 —— 不该被当成 KV 段
  assert.equal(ensureKv.bindingBlockHasId(TOML_WITHOUT_ID, 'DB'), false);
  assert.equal(ensureKv.bindingBlock(TOML_WITHOUT_ID, 'DB'), null);
});

test('expectedTitle：从配置的 name 推导（这是"标题完全一致"判定的唯一依据）', () => {
  assert.equal(ensureKv.expectedTitle(TOML_WITHOUT_ID), 'nodewarden-attachments-kv');
  assert.equal(ensureKv.expectedTitle('[x]\nfoo = 1\n'), 'worker-attachments-kv');
});

test('真实 wrangler.kv.toml：标题契约不变（改名会让复用判定失效，需显式 --id）', () => {
  const toml = readFileSync(path.join(REPO_ROOT, 'wrangler.kv.toml'), 'utf8');
  assert.equal(ensureKv.expectedTitle(toml), 'nodewarden-attachments-kv');
});

// ---------------------------------------------------------------- 不替你猜

test('findSimilarNamespaces：只挑"结尾相同且不等于期望标题"的候选，非数组/非字符串都容忍', () => {
  const namespaces = [
    { title: 'nodewarden-attachments-kv', id: 'a'.repeat(32) }, // 精确匹配 ⇒ 不算"相近"
    { title: 'other-project-attachments-kv', id: 'b'.repeat(32) }, // 相近 ⇒ 要报警
    { title: 'nodewarden-attachments', id: 'c'.repeat(32) }, // 结尾不同 ⇒ 不算
    { title: null, id: 'd'.repeat(32) },
    { id: 'e'.repeat(32) },
  ];
  const similar = ensureKv.findSimilarNamespaces(namespaces, 'nodewarden-attachments-kv');
  assert.deepEqual(similar.map((item) => item.title), ['other-project-attachments-kv']);
  assert.deepEqual(ensureKv.findSimilarNamespaces(null, 'nodewarden-attachments-kv'), []);
});

test('parseCreatedNamespaceId：解析 wrangler 的输出；解析不到必须抛错（不能静默返回 undefined）', () => {
  const output = `🌀 Creating new KV Namespace "nodewarden-attachments-kv"...\n\n[[kv_namespaces]]\nbinding = "ATTACHMENTS_KV"\nid = "${ID}"\n`;
  assert.equal(ensureKv.parseCreatedNamespaceId(output), ID);
  assert.throws(() => ensureKv.parseCreatedNamespaceId('some unrelated output'), /could not parse/);
  assert.throws(() => ensureKv.parseCreatedNamespaceId(''), /could not parse/);
});

// ---------------------------------------------------------------- 写入正确性

test('insertIdIntoBindingBlock：id 必须落在 KV 段内，不能掉进下一段', () => {
  const next = ensureKv.insertIdIntoBindingBlock(TOML_WITHOUT_ID, ID);
  const kvIndex = next.indexOf('binding = "ATTACHMENTS_KV"');
  const idIndex = next.indexOf(`id = "${ID}"`);
  const nextHeaderIndex = next.indexOf('[[', kvIndex + 1);
  assert.ok(kvIndex >= 0 && idIndex > kvIndex, 'id 应写在 KV 段的 binding 行之后');
  assert.ok(
    nextHeaderIndex === -1 || idIndex < nextHeaderIndex,
    'id 必须留在 [[kv_namespaces]] 段内 —— 插到别的段会让部署绑定错乱'
  );
  assert.equal(ensureKv.bindingBlockHasId(next), true);
});

test('insertIdIntoBindingBlock：段缺失 / 已有 id / 非法 id 都要抛错（原来会"打印成功但其实没写"）', () => {
  const missingBlock = 'name = "nodewarden"\n\n[[d1_databases]]\nbinding = "DB"\n';
  assert.throws(() => ensureKv.insertIdIntoBindingBlock(missingBlock, ID), /未能.*写入 id/);

  const withId = ensureKv.insertIdIntoBindingBlock(TOML_WITHOUT_ID, ID);
  assert.throws(() => ensureKv.insertIdIntoBindingBlock(withId, ID), /already has an id/);

  assert.throws(() => ensureKv.insertIdIntoBindingBlock(TOML_WITHOUT_ID, 'not-an-id'), /invalid namespace id/);
});

// ---------------------------------------------------------------- 参数

test('parseArgs：--id / --id= / --force-new / --help；未知参数与非法 id 都报错', () => {
  assert.deepEqual(ensureKv.parseArgs([]), { id: null, forceNew: false, help: false });
  assert.deepEqual(ensureKv.parseArgs(['--id', ID]), { id: ID, forceNew: false, help: false });
  assert.deepEqual(ensureKv.parseArgs([`--id=${ID}`]), { id: ID, forceNew: false, help: false });
  assert.deepEqual(ensureKv.parseArgs(['--force-new']), { id: null, forceNew: true, help: false });
  assert.deepEqual(ensureKv.parseArgs(['--help']), { id: null, forceNew: false, help: true });
  assert.throws(() => ensureKv.parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => ensureKv.parseArgs(['--id', 'short']), /32-character hex/);
});

// ---------------------------------------------------------------- 源码护栏

test('源码护栏：main() 只在作为主模块运行时执行（否则单测一 import 就会去读配置/调 wrangler）', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/ensure-kv.cjs'), 'utf8');
  assert.ok(
    source.includes('if (require.main === module)'),
    '必须有入口守卫：本文件的用例能 import 而不产生任何副作用，靠的就是它'
  );
  assert.ok(!/^main\(\);\s*$/m.test(source), '不得在顶层直接调用 main()');
});

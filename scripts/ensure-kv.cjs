#!/usr/bin/env node
/**
 * Make `deploy:kv` idempotent across repeated builds.
 *
 * KV namespaces are referenced in wrangler config by account-scoped `id`, not
 * by name. The template ships without an id so fresh accounts can provision one
 * on first deploy. In non-interactive builds, wrangler may try to create the
 * same namespace again on later builds and fail with code 10014.
 *
 * 本脚本会**改写受版本控制的 `wrangler.kv.toml`**，写进去的 id 决定「附件写进哪个 KV 库」，所以：
 * 只复用**标题完全一致**的命名空间（标题相近的报错并列出候选，猜错会让附件静默写进别的库）；
 * 回写后**校验** id 确实进了目标段，否则报错退出 —— 原实现格式不匹配时会"打印成功但其实没写"，
 * 下一次构建又去新建（正是本脚本要防的 10014）。`--id <32 位 hex>` 复用指定命名空间，`--force-new`
 * 确认新建；纯函数在文件末尾导出，`main()` 只在作为主模块运行时执行（便于单测）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG = path.resolve(__dirname, '..', 'wrangler.kv.toml');
const BINDING = 'ATTACHMENTS_KV';
const NAMESPACE_ID_RE = /^[0-9a-fA-F]{32}$/;

// Windows 下 npm 的可执行文件带 .cmd 后缀，execFileSync 不经 shell 解析。
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// 用 execFileSync + 参数数组，不再把参数拼进 shell 字符串 —— title 源自
// wrangler.kv.toml 的 name，虽属本地配置，但没有理由让它经过 shell 解释。
const wrangler = (args) =>
  execFileSync(NPX, ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/**
 * 解析 TOML 片段里的 `key = "value"` 赋值（忽略注释与段头）。
 * 手工解析而不 `new RegExp(…)` 动态拼接：避开 Semgrep detect-non-literal-regexp，
 * 也省掉「binding 名里带正则元字符」的转义负担。
 */
function assignmentsIn(block) {
  const found = [];
  for (const rawLine of String(block).split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    found.push({ key, value: line.slice(eq + 1).trim().replace(/^"|"$/g, '') });
  }
  return found;
}

/** 取出 `[[kv_namespaces]]` 里属于该 binding 的那一段（找不到返回 null）。 */
function bindingBlock(toml, binding = BINDING) {
  const target = String(binding);
  const blocks = String(toml).match(/\[\[kv_namespaces\]\][^[]*/g) || [];
  return (
    blocks.find((entry) =>
      assignmentsIn(entry).some((item) => item.key === 'binding' && item.value === target)
    ) || null
  );
}

function bindingBlockHasId(toml, binding = BINDING) {
  const block = bindingBlock(toml, binding);
  return block ? /^\s*id\s*=/m.test(block) : false;
}

function expectedTitle(toml) {
  const name = (toml.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || 'worker';
  return `${name}-${BINDING.toLowerCase().replace(/_/g, '-')}`;
}

/**
 * 「标题相近」只用于**报警**，不再用于自动复用。
 * 之所以还要它：若将来把 Worker 改了名，推导出的标题就不再等于旧命名空间的标题 ——
 * 这时静默新建会让已有附件“凭空消失”，所以要先停下来让人确认。
 */
function findSimilarNamespaces(namespaces, title) {
  const suffix = `-${BINDING.toLowerCase().replace(/_/g, '-')}`;
  return (Array.isArray(namespaces) ? namespaces : []).filter(
    (namespace) =>
      typeof namespace?.title === 'string'
      && namespace.title !== title
      && namespace.title.endsWith(suffix)
  );
}

function parseCreatedNamespaceId(output) {
  const id = (String(output || '').match(/id\s*=\s*"([0-9a-fA-F]{32})"/) || [])[1];
  if (!id) {
    throw new Error(`[ensure-kv] could not parse new namespace id from:\n${output}`);
  }
  return id;
}

/**
 * 把 id 插进属于本 binding 的那一段。
 * 段缺失 / 格式不匹配 / 已有 id 都**抛错** —— 绝不“静默成功”（否则下次构建又会新建）。
 */
function insertIdIntoBindingBlock(toml, id, binding = BINDING) {
  if (!NAMESPACE_ID_RE.test(String(id || ''))) {
    throw new Error(`[ensure-kv] invalid namespace id: ${id}`);
  }
  if (bindingBlockHasId(toml, binding)) {
    throw new Error(`[ensure-kv] binding = "${binding}" already has an id`);
  }
  const target = String(binding);
  const lines = String(toml).split('\n');
  const out = [];
  let inNamespaceBlock = false;
  let inserted = false;
  for (const line of lines) {
    out.push(line);
    if (/^\s*\[\[kv_namespaces\]\]\s*$/.test(line)) {
      inNamespaceBlock = true;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inNamespaceBlock = false;
      continue;
    }
    if (!inNamespaceBlock || inserted) continue;
    const assignment = assignmentsIn(line)[0];
    if (assignment && assignment.key === 'binding' && assignment.value === target) {
      out.push(`id = "${id}"`);
      inserted = true;
    }
  }
  if (!inserted) {
    throw new Error(
      `[ensure-kv] 未能在 wrangler.kv.toml 里为 binding = "${binding}" 写入 id（段缺失或格式不匹配）`
    );
  }
  const next = out.join('\n');
  if (!bindingBlockHasId(next, binding)) {
    throw new Error(`[ensure-kv] 写入后校验失败：binding = "${binding}" 所在的段里仍找不到 id`);
  }
  return next;
}

function parseArgs(argv) {
  const args = { id: null, forceNew: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--force-new') {
      args.forceNew = true;
    } else if (token === '--id') {
      args.id = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--id=')) {
      args.id = token.slice('--id='.length).trim();
    } else {
      throw new Error(`[ensure-kv] unknown argument: ${token}`);
    }
  }
  if (args.id && !NAMESPACE_ID_RE.test(args.id)) {
    throw new Error(`[ensure-kv] --id must be a 32-character hex KV namespace id, got: ${args.id}`);
  }
  return args;
}

const USAGE = [
  '用法：node scripts/ensure-kv.cjs [--id <32 位 hex>] [--force-new]',
  '  （无参数）      标题完全匹配则复用，否则新建',
  '  --id <hex>      显式复用指定命名空间（标题不一致、或账号里存在相近标题时使用）',
  '  --force-new     确认要新建（存在“标题相近”的命名空间时会要求显式选择）',
].join('\n');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const toml = fs.readFileSync(CONFIG, 'utf8');
  if (bindingBlockHasId(toml)) {
    console.log(`[ensure-kv] ${BINDING} already pinned in wrangler.kv.toml; nothing to do`);
    return;
  }

  const title = expectedTitle(toml);
  let id = args.id;

  if (id) {
    console.log(`[ensure-kv] 使用显式指定的命名空间 id（${id}）`);
  } else {
    const namespaces = JSON.parse(wrangler(['kv', 'namespace', 'list']));
    const exact = (Array.isArray(namespaces) ? namespaces : []).find((ns) => ns?.title === title);
    if (exact) {
      id = exact.id;
      console.log(`[ensure-kv] reusing existing namespace "${exact.title}" (${exact.id})`);
    } else {
      const similar = findSimilarNamespaces(namespaces, title);
      if (similar.length && !args.forceNew) {
        throw new Error([
          `[ensure-kv] 账号里没有标题为 "${title}" 的 KV 命名空间，但存在标题相近的：`,
          ...similar.map((ns) => `  · ${ns.title} (${ns.id})`),
          '请显式二选一后重跑（不替你猜 —— 猜错会把附件写进别的库）：',
          '  · 复用其中一个： node scripts/ensure-kv.cjs --id <上面的 id>',
          '  · 确实要新建：   node scripts/ensure-kv.cjs --force-new',
        ].join('\n'));
      }
      id = parseCreatedNamespaceId(wrangler(['kv', 'namespace', 'create', title]));
      console.log(`[ensure-kv] created namespace "${title}" (${id})`);
    }
  }

  fs.writeFileSync(CONFIG, insertIdIntoBindingBlock(toml, id));
  console.log(`[ensure-kv] 已写入 wrangler.kv.toml：binding = "${BINDING}" 段新增 id = "${id}"`);
  console.log('[ensure-kv] wrangler.kv.toml 受版本控制，记得把这次改动一并提交');
}

if (require.main === module) {
  main();
}

module.exports = {
  BINDING,
  bindingBlock,
  bindingBlockHasId,
  expectedTitle,
  findSimilarNamespaces,
  insertIdIntoBindingBlock,
  parseArgs,
  parseCreatedNamespaceId,
};

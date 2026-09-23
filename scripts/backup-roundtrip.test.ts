// 备份 / 恢复端到端 round-trip 测试
//
// 为什么需要：既有的 `security-audit-backup-auth-state.mjs` 只证明了**反向性质**（不该进备份的
// 6 张运行时认证表确实没进去），而**正向性质 —— 该进去的数据完整、且能原样还原 —— 从未被证明**。
//
// 做法：用 node:sqlite 跑**真实 SQL**（真实 schema、真实影子表、真实 swap），然后**逐行比对**两个
// 数据库。纯 mock 做不到 —— 它不存数据，只能断言"发了哪些 SQL"，验证不了字段保真。
//
// 本测试同时把「四处**有意不对称**」钉住：它们不是 bug 而是设计，必须显式记录，否则将来会被误报；
// 反过来，若有人无意改动这些行为，测试会立刻失败。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertBackupDbPayloadRestorable,
  buildBackupArchive,
  parseBackupArchive,
  resolveInlineAttachmentBudgetBytes,
} from '../src/services/backup-archive';
import { BACKUP_SETTINGS_CONFIG_KEY } from '../src/services/backup-config';
import { importBackupArchiveBytes } from '../src/services/backup-import';
import { getAttachmentObjectKey } from '../src/services/blob-store';
import { YUBICO_BOOTSTRAP_CLAIM_CONFIG_KEY } from '../src/services/yubico-config';
import type { Env } from '../src/types';
import { createD1SqliteDatabase } from './lib/d1-sqlite';
import { createR2MemoryBucket } from './lib/r2-memory';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0001_init.sql'), 'utf8');
const NOW = '2026-01-01T00:00:00.000Z';

// backup-archive.ts 内部常量，未导出（`const BACKUP_RUNNER_LOCK_CONFIG_KEY = 'backup.runner.lock.v1'`）
const BACKUP_RUNNER_LOCK_KEY = 'backup.runner.lock.v1';

type Handle = ReturnType<typeof createD1SqliteDatabase>;
type Row = Record<string, unknown>;

function freshDatabase(): Handle {
  const handle = createD1SqliteDatabase();
  handle.connection.exec(SCHEMA_SQL);
  return handle;
}

function envFor(handle: Handle): Env {
  return { DB: handle.db } as unknown as Env;
}

function selectAll(handle: Handle, table: string, orderBy: string): Row[] {
  return handle.connection.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Row[];
}

/** 除 api_key 外逐行一致 —— api_key 属"有意不导出"（见下方对应测试） */
function usersWithoutApiKey(handle: Handle): Row[] {
  return selectAll(handle, 'users', 'id').map(({ api_key: _apiKey, ...rest }) => rest);
}

function configMap(handle: Handle): Record<string, string> {
  const rows = selectAll(handle, 'config', 'key');
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
}

// 8 种 CipherType（src/types/index.ts:120）。每个都带一个"客户端未知字段"，
// 用来验证 CONTRIBUTING 要求的「保留未知/未来字段」。
const CIPHER_TYPES: ReadonlyArray<readonly [number, string]> = [
  [1, 'Login'],
  [2, 'SecureNote'],
  [3, 'Card'],
  [4, 'Identity'],
  [5, 'SSHKey'],
  [6, 'BankAccount'],
  [7, 'DriversLicense'],
  [8, 'Passport'],
];

function seedSource(handle: Handle): void {
  const db = handle.connection;
  db.prepare(
    'INSERT INTO users (id, email, name, master_password_hint, master_password_hash, key, private_key, public_key, kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, security_stamp, role, status, verify_devices, totp_secret, totp_recovery_code, yubikey_key1, yubikey_nfc, api_key, locale, auto_locale, timezone, auto_timezone, mail_opt_in, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'user-1', 'alice@example.test', 'Alice', 'hint', 'master-hash', 'wrapped-key',
    'private-key', 'public-key', 0, 600000, 64, 4, 'stamp-1', 'admin', 'active', 1,
    'totp-secret', 'recovery-code', 'yubi-1', 1, 'API-KEY-MUST-NOT-BE-BACKED-UP',
    // 语言/时区/邮件开关都用**非默认值**：否则「是否随备份往返」这条断言会被 NULL / 0 平凡通过
    'zh-CN', 1, 'Asia/Shanghai', 0, 1, NOW, NOW
  );
  db.prepare('INSERT INTO domain_settings (user_id, equivalent_domains, custom_equivalent_domains, excluded_global_equivalent_domains, updated_at) VALUES (?,?,?,?,?)')
    .run('user-1', '[[1,[2,3]]]', '["a.test"]', '["b.test"]', NOW);
  db.prepare('INSERT INTO user_revisions (user_id, revision_date) VALUES (?,?)').run('user-1', NOW);
  db.prepare('INSERT INTO folders (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('folder-1', 'user-1', 'encrypted-folder-name', NOW, NOW);

  for (const [type, label] of CIPHER_TYPES) {
    db.prepare(
      'INSERT INTO ciphers (id, user_id, type, folder_id, name, notes, favorite, data, reprompt, key, created_at, updated_at, archived_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      `cipher-${type}`,
      'user-1',
      type,
      'folder-1',
      `enc-name-${label}`,
      `enc-notes-${label}`,
      type % 2,
      JSON.stringify({ name: `enc-name-${label}`, type, unknownFutureField: `keep-me-${type}`, nested: { deep: [1, 2, 3] } }),
      type === 1 ? 1 : null,
      `enc-key-${label}`,
      NOW,
      NOW,
      type === 5 ? NOW : null,
      type === 6 ? NOW : null
    );
  }

  db.prepare(
    'INSERT INTO webauthn_credentials (id, user_id, purpose, name, public_key, credential_id, counter, type, aa_guid, transports, encrypted_user_key, encrypted_public_key, encrypted_private_key, supports_prf, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'cred-1', 'user-1', 'login', 'YubiKey 5', 'pub-key', 'cred-id', 7, 'public-key',
    'aa-guid', '["usb","nfc"]', 'enc-usk', 'enc-pub', 'enc-priv', 1, NOW, NOW
  );

  // config：含两个"必须被脱敏丢弃"的内部 key
  db.prepare('INSERT INTO config (key, value) VALUES (?,?)').run('ui.language', 'zh-CN');
  db.prepare('INSERT INTO config (key, value) VALUES (?,?)').run(BACKUP_RUNNER_LOCK_KEY, '{"token":"secret"}');
  db.prepare('INSERT INTO config (key, value) VALUES (?,?)').run(YUBICO_BOOTSTRAP_CLAIM_CONFIG_KEY, 'claim-secret');
  db.prepare('INSERT INTO config (key, value) VALUES (?,?)').run(BACKUP_SETTINGS_CONFIG_KEY, '{"destinations":[]}');

  // sends：用于断言"Send 不参与备份"
  db.prepare(
    'INSERT INTO sends (id, user_id, type, name, data, key, deletion_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('send-1', 'user-1', 0, 'enc-send-name', 'enc-send-data', 'send-key', NOW, NOW, NOW);
}

async function exportBytes(handle: Handle, includeAttachments = false): Promise<Uint8Array> {
  const bundle = await buildBackupArchive(envFor(handle), new Date(NOW), { includeAttachments });
  return bundle.bytes;
}

async function roundTrip(): Promise<{ source: Handle; target: Handle; sourceBytes: Uint8Array; targetBytes: Uint8Array }> {
  const source = freshDatabase();
  seedSource(source);
  const sourceBytes = await exportBytes(source);

  const target = freshDatabase();
  await importBackupArchiveBytes(sourceBytes, envFor(target), 'actor-1', true);
  const targetBytes = await exportBytes(target);

  return { source, target, sourceBytes, targetBytes };
}

// ------------------------------------------------------------------ 导出侧

test('导出覆盖文档化的 8 张表，且不包含运行时认证状态', async () => {
  const handle = freshDatabase();
  seedSource(handle);
  const parsed = parseBackupArchive(await exportBytes(handle)).payload.db as unknown as Record<string, unknown>;
  const tableNames = Object.keys(parsed).sort();
  assert.deepStrictEqual(tableNames, [
    'attachments',
    'ciphers',
    'config',
    'domain_settings',
    'folders',
    'user_revisions',
    'users',
    'webauthn_credentials',
  ]);

  for (const forbidden of [
    'devices',
    'refresh_tokens',
    'auth_requests',
    'trusted_two_factor_device_tokens',
    'account_passkey_challenges',
    'used_attachment_download_tokens',
  ]) {
    assert.ok(!tableNames.includes(forbidden), `导出不应包含运行时认证表 ${forbidden}`);
  }
  handle.close();
});

test('导出为全部 8 种 CipherType 保留客户端未知字段', async () => {
  const handle = freshDatabase();
  seedSource(handle);
  const ciphers = parseBackupArchive(await exportBytes(handle)).payload.db.ciphers as Row[];
  assert.equal(ciphers.length, CIPHER_TYPES.length);

  for (const [type, label] of CIPHER_TYPES) {
    const row = ciphers.find((item) => item.id === `cipher-${type}`);
    assert.ok(row, `缺少 CipherType=${type} (${label}) 的条目`);
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    assert.equal(data.unknownFutureField, `keep-me-${type}`, `CipherType=${type} 的未知字段丢失`);
    assert.deepStrictEqual(data.nested, { deep: [1, 2, 3] });
  }
  handle.close();
});

// ------------------------------------------------------------------ 往返一致性

test('导出 → 导入后，数据逐行一致（除四处已记录的有意不对称）', async () => {
  const { source, target } = await roundTrip();

  for (const [table, orderBy] of [
    ['folders', 'id'],
    ['ciphers', 'id'],
    ['domain_settings', 'user_id'],
    ['user_revisions', 'user_id'],
    ['webauthn_credentials', 'id'],
  ] as const) {
    assert.deepStrictEqual(selectAll(target, table, orderBy), selectAll(source, table, orderBy), `${table} 往返不一致`);
  }

  // users：除 api_key 外完全一致
  assert.deepStrictEqual(usersWithoutApiKey(target), usersWithoutApiKey(source), 'users 往返不一致');

  source.close();
  target.close();
});

test('二次导出与首次导出等价，未知字段仍然保留', async () => {
  const { source, target, sourceBytes, targetBytes } = await roundTrip();

  const first = parseBackupArchive(sourceBytes).payload.db;
  const second = parseBackupArchive(targetBytes).payload.db;

  for (const table of ['folders', 'ciphers', 'domain_settings', 'user_revisions', 'webauthn_credentials'] as const) {
    assert.deepStrictEqual(second[table], first[table], `${table} 二次导出不一致`);
  }

  const cipher = (second.ciphers as Row[]).find((row) => row.id === 'cipher-1');
  assert.ok(cipher);
  assert.equal((JSON.parse(String(cipher.data)) as Row).unknownFutureField, 'keep-me-1');

  source.close();
  target.close();
});

// -------------------------------------------------- 四处「有意不对称」（预期行为）

test('不对称 1：Send 记录不参与备份，恢复后为空', async () => {
  const { source, target } = await roundTrip();

  assert.equal(selectAll(source, 'sends', 'id').length, 1, '源库应有一条 Send');
  assert.equal(selectAll(target, 'sends', 'id').length, 0, '恢复后 Send 表应为空（有意为之）');

  const parsed = parseBackupArchive(await exportBytes(source)).payload.db as unknown as Record<string, unknown>;
  assert.ok(!('sends' in parsed), '导出的 db.json 不应含 sends 表');

  source.close();
  target.close();
});

test('不对称 2：users.api_key 不导出，恢复后为 NULL', async () => {
  const { source, target } = await roundTrip();

  const sourceRow = selectAll(source, 'users', 'id')[0];
  const targetRow = selectAll(target, 'users', 'id')[0];
  assert.equal(sourceRow.api_key, 'API-KEY-MUST-NOT-BE-BACKED-UP');
  assert.equal(targetRow.api_key, null, 'api_key 不应进入备份');

  const exported = parseBackupArchive(await exportBytes(source)).payload.db.users as Row[];
  assert.ok(!Object.prototype.hasOwnProperty.call(exported[0], 'api_key'), '导出不应含 api_key 列');

  source.close();
  target.close();
});

test('不对称 3：内部 config key 被脱敏，不进入备份', async () => {
  const source = freshDatabase();
  seedSource(source);

  const exported = configMapFromPayload(await exportBytes(source));
  assert.ok(!(BACKUP_RUNNER_LOCK_KEY in exported), '运行锁 key 不应进入备份');
  assert.ok(!(YUBICO_BOOTSTRAP_CLAIM_CONFIG_KEY in exported), 'Yubico 引导声明 key 不应进入备份');
  assert.equal(exported['ui.language'], 'zh-CN', '普通 config 应完整保留');

  source.close();
});

test('不对称 4：恢复会强制把实例标记为 registered', async () => {
  const { source, target } = await roundTrip();

  assert.ok(!('registered' in configMap(source)), '源库无需 registered 标记');
  assert.equal(configMap(target).registered, 'true', '恢复后必须标记为已注册，避免首用户提权逻辑误触发');

  source.close();
  target.close();
});

/** 直接从归档里取 config 行（不经过导入） */
function configMapFromPayload(bytes: Uint8Array): Record<string, string> {
  const rows = parseBackupArchive(bytes).payload.db.config as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
}

// ------------------------------------------------------------------ 附件（blob）

const ATTACHMENT_ID = 'attachment-1';
const ATTACHMENT_CIPHER_ID = 'cipher-1';
const ATTACHMENT_BYTES = new TextEncoder().encode('CONFIDENTIAL-ATTACHMENT-BYTES');
const ATTACHMENT_ZIP_PATH = `attachments/${ATTACHMENT_CIPHER_ID}/${ATTACHMENT_ID}.bin`;

/** 给源库加一条附件元数据行（blob 由调用方放进 R2） */
function seedAttachmentRow(handle: Handle): void {
  handle.connection
    .prepare('INSERT INTO attachments (id, cipher_id, file_name, size, size_name, key) VALUES (?,?,?,?,?,?)')
    .run(
      ATTACHMENT_ID,
      ATTACHMENT_CIPHER_ID,
      'encrypted-file-name',
      ATTACHMENT_BYTES.byteLength,
      `${ATTACHMENT_BYTES.byteLength} B`,
      'enc-file-key'
    );
}

async function exportWithAttachments(options: { inlineAttachmentBlobs?: boolean } = {}) {
  const source = freshDatabase();
  seedSource(source);
  seedAttachmentRow(source);

  const r2 = createR2MemoryBucket();
  await r2.bucket.put(getAttachmentObjectKey(ATTACHMENT_CIPHER_ID, ATTACHMENT_ID), ATTACHMENT_BYTES, {
    httpMetadata: { contentType: 'application/pdf' },
  });

  const bundle = await buildBackupArchive(
    { DB: source.db, ATTACHMENTS: r2.bucket } as unknown as Env,
    new Date(NOW),
    { includeAttachments: true, ...options }
  );
  return { source, r2, bytes: bundle.bytes, manifest: bundle.manifest };
}

test('附件 1：本地导出勾选「包含附件」时，zip 必须自包含附件文件', async () => {
  const { source, bytes } = await exportWithAttachments({ inlineAttachmentBlobs: true });

  const names = Object.keys(parseBackupArchive(bytes, { allowExternalAttachmentBlobs: true }).files);
  assert.ok(
    names.includes(ATTACHMENT_ZIP_PATH),
    `zip 应内联附件文件，实际条目：${JSON.stringify(names)}`
  );

  source.close();
});

test('附件 2：该 zip 必须能被本地导入接受，且 blob 内容与元数据一致', async () => {
  const { source, bytes } = await exportWithAttachments({ inlineAttachmentBlobs: true });

  const target = freshDatabase();
  const targetR2 = createR2MemoryBucket();
  const result = await importBackupArchiveBytes(
    bytes,
    { DB: target.db, ATTACHMENTS: targetR2.bucket } as unknown as Env,
    'actor-1',
    true
  );

  assert.equal(result.result.skipped.attachments, 0, '不应有被跳过的附件');
  assert.deepStrictEqual(
    targetR2.bytesOf(getAttachmentObjectKey(ATTACHMENT_CIPHER_ID, ATTACHMENT_ID)),
    ATTACHMENT_BYTES,
    '恢复后的 blob 内容应与源一致'
  );
  assert.deepStrictEqual(selectAll(target, 'attachments', 'id'), selectAll(source, 'attachments', 'id'));

  source.close();
  target.close();
});

test('附件 3：blob 缺失时应明确报错，而不是产出静默不完整的 zip', async () => {
  const source = freshDatabase();
  seedSource(source);
  seedAttachmentRow(source); // 有元数据行，但 R2 里没有对应 blob

  const emptyR2 = createR2MemoryBucket();
  await assert.rejects(
    () =>
      buildBackupArchive(
        { DB: source.db, ATTACHMENTS: emptyR2.bucket } as unknown as Env,
        new Date(NOW),
        { includeAttachments: true, inlineAttachmentBlobs: true }
      ),
    /blob missing/i
  );

  source.close();
});

test('附件 4：不内联时归档仍只含元数据 —— 保护远端"单独增量上传"的既有设计', async () => {
  const { source, bytes, manifest } = await exportWithAttachments();

  const names = Object.keys(parseBackupArchive(bytes, { allowExternalAttachmentBlobs: true }).files);
  assert.deepStrictEqual(names.sort(), ['db.json', 'manifest.json'], '未内联时不应含附件文件');
  assert.equal(manifest.includes.attachments, true);
  assert.equal(manifest.attachmentBlobs?.length, 1, '元数据仍须列出待上传的 blob');

  source.close();
});

test('附件 5：仅元数据的远端归档走本地导入时，应给出可操作的提示', async () => {
  // 远端备份的归档不含附件字节（附件由 uploadRemoteAttachmentChunk 单独增量上传），
  // 而本地导入要求内联 → 必然失败。**失败是正确的**，但必须告诉用户"该怎么办"，
  // 而不是一句通用的 `missing required file: attachments/...`（且该文案此前还未接入 i18n，
  // 所有语言看到都是英文）。
  const { source, bytes } = await exportWithAttachments(); // 不内联 = 远端形态

  const target = freshDatabase();
  await assert.rejects(
    () => importBackupArchiveBytes(bytes, { DB: target.db } as unknown as Env, 'actor-1', true),
    (error: Error) => {
      assert.match(
        error.message,
        /restore it from the remote destination instead/i,
        `应提示改用"从远端恢复"，实际消息：${error.message}`
      );
      assert.doesNotMatch(error.message, /missing required file/i, '不应再是通用文案');
      return true;
    }
  );

  source.close();
  target.close();
});

test('附件 6：附件相关的后端文案必须已登记到 i18n 映射表（否则用户会看到英文原文）', () => {
  // 前端靠「英文字符串 → i18n 键」查表来本地化后端错误（webapp/src/lib/i18n.ts 的
  // translateServerError），**未命中就原样显示英文**。因此后端新增文案时必须同步登记 ——
  // 这条关联极易被后来者遗漏（改后端字符串不会有任何编译期报错），故用测试锁住。
  const archiveSource = readFileSync(path.join(REPO_ROOT, 'src/services/backup-archive.ts'), 'utf8');
  const message = archiveSource.match(/const MISSING_ATTACHMENT_FILES_MESSAGE\s*=\s*'([^']+)'/)?.[1];
  assert.ok(message, '应能从 backup-archive.ts 提取 MISSING_ATTACHMENT_FILES_MESSAGE');

  const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const i18nSource = readFileSync(path.join(REPO_ROOT, 'webapp/src/lib/i18n.ts'), 'utf8');
  const mapped = i18nSource.match(new RegExp(`'${escaped}':\\s*'([^']+)'`))?.[1];
  assert.ok(mapped, `i18n 映射表缺少该后端文案的条目：${message}`);

  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'fi', 'de', 'fr', 'it', 'sv']) {
    const localeSource = readFileSync(
      path.join(REPO_ROOT, `webapp/src/lib/i18n/locales/${locale}.ts`),
      'utf8'
    );
    assert.ok(localeSource.includes(`"${mapped}"`), `${locale} 缺少键 ${mapped}`);
  }
});

test('附件 7：内联导出超出体积预算时必须拒绝，而不是产出无法本地恢复的归档', async () => {
  // 回归点：此前的预检只把「附件字节数」与 64 MiB 比较 —— 既没算进 db.json（恢复侧按
  // 解压后**总**字节判定上限，见 createBackupUnzipFilter），也没考虑 zipSync 会把内存
  // 占用翻倍。结果是导出成功、但本地导入必然失败的归档。
  const source = freshDatabase();
  seedSource(source);
  const oversizedBytes = 33 * 1024 * 1024; // 超过 32 MiB 的内联总量上限
  source.connection
    .prepare('INSERT INTO attachments (id, cipher_id, file_name, size, size_name, key) VALUES (?,?,?,?,?,?)')
    .run(ATTACHMENT_ID, ATTACHMENT_CIPHER_ID, 'encrypted-file-name', oversizedBytes, `${oversizedBytes} B`, 'enc-file-key');

  // 故意不放 blob：预检必须**早于**读 blob 触发，否则本用例会以 /blob missing/ 通过
  const emptyR2 = createR2MemoryBucket();
  await assert.rejects(
    () =>
      buildBackupArchive(
        { DB: source.db, ATTACHMENTS: emptyR2.bucket } as unknown as Env,
        new Date(NOW),
        { includeAttachments: true, inlineAttachmentBlobs: true }
      ),
    (error: Error) => {
      assert.match(error.message, /is too large to export/i, `应报导出体积超限，实际：${error.message}`);
      assert.doesNotMatch(error.message, /blob missing/i, '应在读取 blob 之前就拒绝');
      return true;
    }
  );

  source.close();
});

test('附件 8：内联预算必须同时扣除 db.json 并满足内存上限', () => {
  const MIB = 1024 * 1024;
  // 2 ×（db.json + 附件）是内联导出的峰值内存，必须显著低于 Worker 的 128 MB 上限
  for (const dbPayloadBytes of [0, MIB, 16 * MIB, 31 * MIB]) {
    const budget = resolveInlineAttachmentBudgetBytes(dbPayloadBytes);
    const total = dbPayloadBytes + budget;
    assert.equal(total, 32 * MIB, `db.json = ${dbPayloadBytes} 时解压后总量上限应恒为 32 MiB`);
    assert.ok(2 * total <= 128 * MIB, `峰值内存 ${2 * total} 必须低于 Worker 上限`);
  }
  // db.json 自身超出恢复侧单条目上限（32 MiB）时，预算必须为负 —— 任何附件都不许内联
  assert.ok(resolveInlineAttachmentBudgetBytes(40 * MIB) < 0, 'db.json 过大时必须拒绝内联');
});

test('附件 9：导出体积超限文案必须已登记到 i18n 映射表（正则形式）', () => {
  // 与「附件 6」同一类问题：后端文案未被前端识别时，用户看到的是英文原文。
  // 该文案带会变化的字节数，无法精确查表，只能用「前缀 + 数字」正则，故断言正则本身存在。
  const archiveSource = readFileSync(path.join(REPO_ROOT, 'src/services/backup-archive.ts'), 'utf8');
  const prefix = archiveSource.match(/TOO_LARGE_TO_EXPORT_MESSAGE_PREFIX\s*=\s*'([^']+)'/)?.[1];
  assert.ok(prefix, '应能从 backup-archive.ts 提取 TOO_LARGE_TO_EXPORT_MESSAGE_PREFIX');

  const i18nSource = readFileSync(path.join(REPO_ROOT, 'webapp/src/lib/i18n.ts'), 'utf8');
  assert.ok(i18nSource.includes(prefix), `i18n 正则表缺少该前缀：${prefix}`);
  assert.ok(i18nSource.includes('txt_backup_error_archive_export_too_large'), 'i18n 映射表应引用 txt_backup_error_archive_export_too_large');

  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'fi', 'de', 'fr', 'it', 'sv']) {
    const localeSource = readFileSync(
      path.join(REPO_ROOT, `webapp/src/lib/i18n/locales/${locale}.ts`),
      'utf8'
    );
    assert.ok(
      localeSource.includes('"txt_backup_error_archive_export_too_large"'),
      `${locale} 缺少键 txt_backup_error_archive_export_too_large`
    );
  }
});

test('附件 10：导出侧 db.json 上限必须与恢复侧的单条目上限一致（32 MiB）', () => {
  const MIB = 1024 * 1024;
  // 这两个数字必须锁在一起：导出放行的体积一旦超过恢复侧的 MAX_BACKUP_DB_JSON_BYTES，
  // 就会重新出现"导出成功、但谁都无法恢复"的归档。此处把 33554432 写死，
  // 目的是让任何单方面调整上限的改动都会立刻让本用例失败。
  assertBackupDbPayloadRestorable(32 * MIB, 32 * MIB);
  assert.throws(
    () => assertBackupDbPayloadRestorable(32 * MIB + 1),
    /^Error: Backup database payload is too large to restore: 33554433 database bytes exceed the 33554432 byte limit$/
  );
});

test('附件 11：不内联附件的导出路径也必须做 db.json 体积预检（回归）', async () => {
  // 回归点：预检过去只存在于 `includeAttachments && inlineAttachmentBlobs` 分支里，
  // 于是**远端 / 定时备份**与**本地导出但不勾选附件**都会产出恢复侧必然拒收的归档。
  const source = freshDatabase();
  seedSource(source);

  // 真实上限是 32 MiB，为覆盖拒绝分支注入一个极小的上限（生产调用方不传这个参数）
  await assert.rejects(
    () =>
      buildBackupArchive(envFor(source), new Date(NOW), {
        includeAttachments: false,
        restorableDbPayloadLimitBytes: 512,
      }),
    (error: Error) => {
      assert.match(error.message, /database payload is too large to restore/i, `应报 db.json 超限，实际：${error.message}`);
      assert.match(error.message, /exceed the 512 byte limit/, '报错应带上具体字节数与上限');
      return true;
    }
  );

  // 对照：同一份数据在默认上限下必须能正常导出 —— 证明上面的失败源于体积，而非其他错误
  const bundle = await buildBackupArchive(envFor(source), new Date(NOW), { includeAttachments: false });
  assert.ok(bundle.bytes.byteLength > 0);
  assert.ok(bundle.manifest.tableCounts.ciphers > 0);

  source.close();
});

test('附件 12：db.json 超限文案必须已登记到 i18n 映射表（正则形式）', () => {
  const archiveSource = readFileSync(path.join(REPO_ROOT, 'src/services/backup-archive.ts'), 'utf8');
  const prefix = archiveSource.match(/TOO_LARGE_DB_PAYLOAD_MESSAGE_PREFIX\s*=\s*'([^']+)'/)?.[1];
  assert.ok(prefix, '应能从 backup-archive.ts 提取 TOO_LARGE_DB_PAYLOAD_MESSAGE_PREFIX');

  const i18nSource = readFileSync(path.join(REPO_ROOT, 'webapp/src/lib/i18n.ts'), 'utf8');
  assert.ok(i18nSource.includes(prefix), `i18n 正则表缺少该前缀：${prefix}`);
  assert.ok(
    i18nSource.includes('txt_backup_error_archive_db_payload_too_large'),
    'i18n 映射表应引用 txt_backup_error_archive_db_payload_too_large'
  );

  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'fi', 'de', 'fr', 'it', 'sv']) {
    const localeSource = readFileSync(
      path.join(REPO_ROOT, `webapp/src/lib/i18n/locales/${locale}.ts`),
      'utf8'
    );
    assert.ok(
      localeSource.includes('"txt_backup_error_archive_db_payload_too_large"'),
      `${locale} 缺少键 txt_backup_error_archive_db_payload_too_large`
    );
  }
});

test('附件 13：解析后必须释放 db.json 的解压字节（否则与解析出的对象树同时占内存）', async () => {
  const source = freshDatabase();
  seedSource(source);
  const parsed = parseBackupArchive(await exportBytes(source));

  // 条目名保留（调用方仍能列举归档内容），但字节已被释放
  assert.deepStrictEqual(Object.keys(parsed.files).sort(), ['db.json', 'manifest.json']);
  assert.equal(parsed.files['db.json'].byteLength, 0, 'db.json 的解压字节应在解析后立即释放');
  assert.ok(parsed.payload.db.ciphers.length > 0, '数据本身必须完整解析出来');
  assert.ok(parsed.payload.db.users.length > 0);

  source.close();
});

test('附件 14：恢复写入必须分批提交，而不是整表一个 db.batch', async () => {
  const ROW_TOTAL = 500;
  const source = freshDatabase();
  seedSource(source);
  // 加行到远超一批：整表一次提交的实现会在这里出现一个 500+ 条的 batch
  const insert = source.connection.prepare(
    'INSERT INTO ciphers (id, user_id, type, folder_id, name, notes, favorite, data, reprompt, key, created_at, updated_at, archived_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (let i = 0; i < ROW_TOTAL; i++) {
    const id = `bulk-${i}`;
    insert.run(id, 'user-1', 1, 'folder-1', `enc-name-${i}`, `enc-notes-${i}`, 0, JSON.stringify({ i }), null, null, NOW, NOW, null, null);
  }
  const bytes = await exportBytes(source);

  const target = freshDatabase();
  const batches: number[] = [];
  const countingDb = new Proxy(target.db, {
    get(targetDb, property, receiver) {
      if (property === 'batch') {
        return async (statements: unknown[]) => {
          batches.push(statements.length);
          return (targetDb.batch as (items: unknown[]) => Promise<unknown>)(statements);
        };
      }
      const value = Reflect.get(targetDb, property, receiver);
      return typeof value === 'function' ? value.bind(targetDb) : value;
    },
  });

  await importBackupArchiveBytes(bytes, { DB: countingDb } as unknown as Env, 'user-1', false);

  const cipherRows = selectAll(target, 'ciphers', 'id');
  assert.equal(cipherRows.length, ROW_TOTAL + CIPHER_TYPES.length, '全部行都必须写进去');
  assert.ok(batches.length > 1, `应分多次 batch 提交，实际只调用 ${batches.length} 次`);
  const largest = Math.max(...batches);
  assert.ok(largest <= 200, `单批不应超过 200 条语句，实际最大 ${largest}`);

  source.close();
  target.close();
});

// ────────────────────────────────────────── 「进度上报不得决定业务成败」的守卫
//
// 不变式的定义与背景见 `src/services/backup-progress.ts` 的 CONTRACT（即 H3 事故）。
// 简言之：`handlers/backup.ts` 传给恢复流程的进度回调会先 `touchLease()` 去续 Durable Object
// 的作业租约，而那一步**会抛**；当时的调用点写的是裸 `await progress?.(...)`，于是「上报失败」
// 被当成了「恢复失败」。下面两条分别钉住它的两个后果。

test('附件 15：进度上报每次抛错，也必须导入成功且数据真的落库', async () => {
  const source = freshDatabase();
  seedSource(source);
  const sourceBytes = await exportBytes(source);

  const target = freshDatabase();
  const reported: string[] = [];
  const imported = await importBackupArchiveBytes(sourceBytes, envFor(target), 'actor-1', true, async (event) => {
    reported.push(event.step);
    // 用 async + throw 贴近真实：`touchLease()` 是在 await 之后失败的
    throw new Error('progress callback exploded');
  });

  assert.ok(reported.length > 0, '前置条件：回调应确实被调用过，否则本测试没覆盖到真实场景');
  assert.ok(
    reported.includes('local_complete'),
    `「完成」阶段也必须尝试上报过 —— 它正是过去会对外报 500 的那一处；实际：${JSON.stringify(reported)}`
  );

  // 导入必须报成功，且数据真的落库 —— 否则「成功」只是假象
  assert.equal(imported.result.imported.users, 1);
  assert.equal(
    (target.connection.prepare('SELECT COUNT(*) AS count FROM ciphers').get() as { count: number }).count,
    CIPHER_TYPES.length
  );

  source.close();
  target.close();
});

test('附件 16：导入失败时，进度上报抛错不得覆盖原始的失败原因', async () => {
  const source = freshDatabase();
  seedSource(source);
  const sourceBytes = await exportBytes(source);
  const target = freshDatabase();
  const reported: string[] = [];

  // 让写库这一步在 try 内部失败（真失败），从而走到 catch 里的「失败」上报那一步。
  // 注：缺 ATTACHMENTS 绑定不是真失败 —— 附件会被记入 `skipped` 并继续，那是设计。
  //
  // 触发时机刻意用「首次进度上报之后再失败」而不是数第几次 batch：清理残留的
  // resetRestoreArtifacts() 跑在 try **之前**，若在那里就失败，永远不会走到 catch 里的
  // 失败上报，这条测试就变成空断言了（下面那条前置断言就是为此设的）。
  const failingDb = new Proxy(target.db, {
    get(targetDb, property, receiver) {
      if (property === 'batch') {
        return async (statements: unknown[]) => {
          if (reported.length === 0) {
            return (targetDb.batch as (items: unknown[]) => Promise<unknown>)(statements);
          }
          throw new Error('database exploded');
        };
      }
      const value = Reflect.get(targetDb, property, receiver);
      return typeof value === 'function' ? value.bind(targetDb) : value;
    },
  });

  await assert.rejects(
    () =>
      importBackupArchiveBytes(sourceBytes, { DB: failingDb } as unknown as Env, 'actor-1', true, async (event) => {
        reported.push(event.step);
        throw new Error('progress callback exploded');
      }),
    (error: Error) => {
      assert.match(error.message, /database exploded/i, `抛出的应是原始的失败原因，实际：${error.message}`);
      assert.doesNotMatch(
        error.message,
        /progress callback exploded/i,
        '进度回调的错误绝不能覆盖原始失败原因（否则排障时看不到真因）'
      );
      return true;
    }
  );

  assert.ok(
    reported.includes('local_failed'),
    `前置条件：失败阶段应尝试上报过，否则本测试没覆盖到「覆盖原始原因」这条分支；实际：${JSON.stringify(reported)}`
  );

  source.close();
  target.close();
});

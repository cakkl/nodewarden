// 跨端 i18n 护栏：文案键与语言清单都不能只改一半。
//
// 两类静默失配（都已发生）：
// 1. 代码里用了语言包**不存在**的键 —— `t()` 找不到键时原样返回键名，界面上直接显示
//    `txt_xxx`。编译、类型、`i18n:validate` 都发现不了（后者只比对语言包之间的键一致性）。
// 2. 界面语言清单与邮件模板语言清单分居前后端，只改一边就会出现「界面切到某语言、邮件仍是英文」。
//
// 清单用**源码文本抽取**而不是 import：两份清单分属不同 tsconfig（DOM lib 与
// @cloudflare/workers-types 的全局声明互斥），同一个测试里互相 import 会产生 29 个真实报错。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import en from '../../webapp/src/lib/i18n/locales/en';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WEBAPP_SRC = path.join(REPO_ROOT, 'webapp', 'src');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** 抽取两个语言清单：界面侧（TS 数组里的 `value: '…'`）与邮件侧（`MailLocale` 联合类型）。 */
function readLocaleLists(): { webapp: string[]; mail: string[] } {
  const webappSource = readSource('webapp/src/lib/i18n.ts');
  const webappBlock = webappSource.match(/export const AVAILABLE_LOCALES[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(webappBlock, '未能从 webapp/src/lib/i18n.ts 抽出 AVAILABLE_LOCALES —— 清单写法变了，本护栏要跟着改');

  const mailSource = readSource('src/services/mail/index.ts');
  const mailBlock = mailSource.match(/export type MailLocale =([^;]+);/);
  assert.ok(mailBlock, '未能从 src/services/mail/index.ts 抽出 MailLocale 联合类型 —— 类型写法变了，本护栏要跟着改');

  const pick = (text: string, pattern: RegExp): string[] =>
    [...text.matchAll(pattern)].map((match) => match[1]);

  const webapp = pick(webappBlock[1], /value:\s*'([^']+)'/g);
  const mail = pick(mailBlock[1], /'([^']+)'/g);

  // 抽取为空 = 正则失效，必须**大声失败**，否则这条护栏会变成永远为真的假绿。
  assert.ok(webapp.length >= 5, `界面语言清单只抽到 ${webapp.length} 项，抽取逻辑可能已失效`);
  assert.ok(mail.length >= 5, `邮件语言清单只抽到 ${mail.length} 项，抽取逻辑可能已失效`);
  return { webapp, mail };
}

test('护栏自检：能抽出两份语言清单，且都无重复项', () => {
  const { webapp, mail } = readLocaleLists();
  assert.equal(new Set(webapp).size, webapp.length, '界面语言清单里有重复项');
  assert.equal(new Set(mail).size, mail.length, '邮件语言清单里有重复项');
});

test('界面语言清单与邮件模板语言清单**逐项相等**（含顺序）', () => {
  const { webapp, mail } = readLocaleLists();

  // 用逐项比对而不是集合比对：顺序不同也意味着下拉框与模板表的直觉不一致，值得一并纠正。
  assert.deepEqual(
    webapp,
    mail,
    '两处语言清单不一致 —— 加/删语言时必须同时改 webapp/src/lib/i18n.ts 与 src/services/mail/index.ts'
  );
});

test('两份清单里的每个语言都有对应的语言包文件（且没有多余文件）', () => {
  const { webapp } = readLocaleLists();
  const dirs = [
    { label: '界面', dir: path.join(WEBAPP_SRC, 'lib', 'i18n', 'locales') },
    { label: '邮件', dir: path.join(REPO_ROOT, 'src', 'services', 'mail', 'locales') },
  ];

  for (const { label, dir } of dirs) {
    const onDisk = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, ''))
      .sort();
    assert.deepEqual([...webapp].sort(), onDisk, `${label}语言包目录与语言清单不一致`);
  }
});

test('代码里以字面量形式使用的文案键都存在于英文语言包', () => {
  // 只扫字面量 `t('key')`：动态拼接（`t(`txt_log_level_${level}`)`）无法静态校验，
  // 由各功能自己的护栏覆盖（如 LogCenterPage 的日志级别清单）。
  const keyPattern = /\bt\(\s*'([A-Za-z0-9_]+)'/g;
  const used = new Map<string, Set<string>>();

  for (const file of listSourceFiles(WEBAPP_SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(keyPattern)) {
      const key = match[1];
      if (!used.has(key)) used.set(key, new Set());
      used.get(key)!.add(path.relative(REPO_ROOT, file));
    }
  }

  // 自检：扫不到东西说明文件遍历或正则坏了，此时「没有缺键」是假的。
  assert.ok(used.size > 100, `只扫到 ${used.size} 个文案键，扫描逻辑可能已失效`);

  const missing = [...used.keys()].filter((key) => !(key in en)).sort();
  assert.deepEqual(
    missing,
    [],
    `以下文案键在代码里被使用，但英文语言包（进而所有语言包）里不存在，界面会原样显示键名：\n` +
      missing.map((key) => `  ${key}  ←  ${[...used.get(key)!].join(', ')}`).join('\n')
  );
});

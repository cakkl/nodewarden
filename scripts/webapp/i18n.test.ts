// webapp 纯逻辑测试：i18n 插值与「服务端错误串 → 文案」的映射
//
// 为什么值得测：这两件事都是**静默失败**型的 —— 插值缺参数会变成空字符串（页面上是一句说不通的
// 话，而不是报错）；`translateServerError` 映射不到时会**回退成原始英文串**，非英文用户会突然看到
// 一句英文。这类问题很难在 UI 走查里发现（除非恰好用非英文界面复现那条错误）。
//
// 注意：`webapp/src/lib/i18n.ts` 在模块加载时就把 `activeMessages` 初始化为英文语言包，且 locale
// 探测包在 try/catch 里，因此**在 Node 里可直接使用，无需 DOM 桩、无需 initI18n()**。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AVAILABLE_LOCALES, getLocale, setLocale, t, translateServerError } from '../../webapp/src/lib/i18n';
import { REMOTE_REQUEST_ACTIONS, buildRemoteTimeoutMessage } from '../../shared/backup-timeout-message';

// ---------------------------------------------------------------- 插值

test('t：未映射的 key 原样返回（而不是空串或 undefined）', () => {
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
});

test('t：把 {name} 占位符替换成参数值（用真实语言包键）', () => {
  // 用真实的英文语言包键，而不是自己搭一个 template —— 这样若键名被改，用例会红
  assert.equal(t('txt_yubikey_x', { index: '2' }), 'YubiKey 2');
  assert.equal(t('txt_generator_character_count', { count: 20 }), '20 characters');
  assert.equal(t('txt_backup_progress_subject', { name: 'my-cipher' }), 'Current item: my-cipher');
});

test('t：同一个键里的多个不同占位符都能替换', () => {
  const result = t('txt_backup_restore_skipped_summary', { reason: 'Unsupported type', attachments: '3' });
  assert.equal(result, 'Unsupported type. Skipped 3 attachment(s).');
});

test('t：缺失的参数会变成空串（静默失败点，此处记录既有行为）', () => {
  // 参数名拼错或忘记传，既不报错也不残留 `{index}`，而是产出空串 ——
  // 页面上就是「YubiKey 」这样一句缺了内容的话。这里是**记录**而不是认可该行为。
  assert.equal(t('txt_yubikey_x', {}), 'YubiKey ', '缺失参数会留下空位，不会残留占位符');
  assert.equal(t('txt_yubikey_x', { wrongName: '2' }), 'YubiKey ', '参数名拼错同样静默变空');
  assert.equal(t('txt_yubikey_x', { index: null }), 'YubiKey ', 'null 也被当作缺失');
});

test('t：数字参数会被转成字符串', () => {
  assert.equal(t('txt_backup_error_destination_limit', { count: 5 }), 'You can save up to 5 backup destinations.');
});

test('AVAILABLE_LOCALES：每一项都有 value 与 label，且包含英文', () => {
  assert.ok(
    AVAILABLE_LOCALES.some((item) => item.value === 'en'),
    '语言列表必须包含英文 —— 它是所有缺失翻译的兜底'
  );
  for (const item of AVAILABLE_LOCALES) {
    assert.ok(item.value && item.label, `语言项必须同时有 value 与 label：${JSON.stringify(item)}`);
  }
});

test('getLocale：返回的一定是合法 locale（环境探测失败时才回退到 en）', () => {
  // 不能写死断言 'en' —— 本地跑时 `navigator.language` 是真实存在的（实测 `zh-CN`），
  // 函数会据此正确探测出语言。真正的不变量是「返回值必定在语言表里」。
  const current = getLocale();
  assert.ok(
    AVAILABLE_LOCALES.some((item) => item.value === current),
    `getLocale() 必须返回语言表里的值，实际 ${JSON.stringify(current)}`
  );
});

// ---------------------------------------------------------------- 服务端错误映射

test('translateServerError：空 / 空白 / null / undefined 一律回退为调用方给的文案', () => {
  for (const input of ['', '   ', '\n\t', null, undefined]) {
    assert.equal(
      translateServerError(input, 'fallback-text'),
      'fallback-text',
      `入参 ${JSON.stringify(input)} 应回退`
    );
  }
});

test('translateServerError：带数字的模式串会被参数化翻译，数字被保留', () => {
  const result = translateServerError('Rate limit exceeded. Try again in 42 seconds.', 'fallback');
  assert.notEqual(result, 'fallback', '这是有专用映射的形式，不该回退');
  assert.ok(result.includes('42'), `秒数应出现在文案里，实际：${result}`);
});

test('translateServerError：模式匹配不区分大小写，且要求整串匹配', () => {
  const lower = translateServerError('rate limit exceeded. try again in 7 seconds.', 'fallback');
  const upper = translateServerError('RATE LIMIT EXCEEDED. TRY AGAIN IN 7 SECONDS.', 'fallback');
  assert.equal(lower, upper, '大小写不同的同一条消息应得到同样结果');

  // 前后多出内容就不再匹配模式 → 走表查 → 查不到 → 返回原文
  const noisy = translateServerError('Error: Rate limit exceeded. Try again in 7 seconds.', 'fallback');
  assert.equal(noisy, 'Error: Rate limit exceeded. Try again in 7 seconds.', '整串不匹配时应返回原文');
});

test('translateServerError：**映射不到时返回原始英文串**（这是既有的兜底，已固化）', () => {
  const result = translateServerError('Some brand new server error that has no mapping', 'fallback');
  assert.equal(
    result,
    'Some brand new server error that has no mapping',
    '既不是 fallback 也不是空串 —— 非英文界面下会看到英文原文，改动映射表时需留意这一点'
  );
});

test('translateServerError：前后空白会被裁掉后再查表', () => {
  const padded = translateServerError('   masterPasswordHash is required   ', 'fallback');
  const bare = translateServerError('masterPasswordHash is required', 'fallback');
  assert.equal(padded, bare, '两侧空白不应影响映射结果');
});

// ---------------------------------------------------------------- 远端备份超时
//
// 为什么值得测：后端把远端超时消息写成「WebDAV upload timed out after 15000 ms」这种**毫秒**形态，
// 映射不到时管理员会直接看到这串英文；而“毫秒 / 秒”换算写错时界面会出现「15000 秒」—— 都是静默失败。
// ⚠️ 样例**必须**用共享构造器 `buildRemoteTimeoutMessage()` 生成：手写字符串的话，后端改措辞时这里
// 会继续绿，而用户那边已经退回英文原文。
test('translateServerError：远端超时消息被换算成秒并落到本地化文案', () => {
  assert.equal(
    translateServerError(buildRemoteTimeoutMessage('WebDAV', 'upload', 15000), 'fallback'),
    'The remote backup destination did not respond in time (timed out after 15s). '
      + 'Check the address, network connectivity, and credentials, then try again.'
  );
  assert.equal(
    translateServerError(buildRemoteTimeoutMessage('S3', 'listing', 500), 'fallback'),
    'The remote backup destination did not respond in time (timed out after 0.5s). '
      + 'Check the address, network connectivity, and credentials, then try again.'
  );
});

test('translateServerError：所有 provider × action 组合都能命中本地化文案（映射分支被删就会红）', () => {
  for (const action of REMOTE_REQUEST_ACTIONS) {
    for (const provider of ['WebDAV', 'S3'] as const) {
      const translated = translateServerError(buildRemoteTimeoutMessage(provider, action, 12345), 'FALLBACK');
      assert.notEqual(translated, 'FALLBACK', `${provider} ${action} 未被映射命中 ⇒ 界面会显示英文原文`);
      assert.ok(
        !translated.includes('12345'),
        '毫秒必须换算成秒，否则界面会出现「12345 秒」这种读数'
      );
      assert.match(translated, /12(?:\.\d)?s/);
    }
  }
});

test('translateServerError：HTTP 状态类失败仍按「provider + 动作 + 状态码」文案渲染（不应被超时分支抢走）', () => {
  assert.equal(
    translateServerError('WebDAV upload failed: 403', 'fallback'),
    'WebDAV upload failed: HTTP 403.'
  );
});

// -------------------------------------------- 日志中心标签覆盖（防「静默退回英文」）
//
// `LogCenterPage` 把审计里的四类**值**拼成键去查标签（`txt_log_{action,reason,trigger,target_type}_<snake>`），
// 查不到就 humanize 成英文 —— 不报错、不警告，中文界面上就那么冒出一句 `Lease / Held`。
// 实测踩过：`backup.scheduled.skipped` 的动作、`lease_held` 等原因、`error` 里的整句英文都中过招。
// 所以这里扫源码、按四类逐个验十种语言都有标签；**新增事件时忘了加标签会直接变红**。

/** 与 `webapp/src/components/LogCenterPage.tsx` 的 `keyFor()` 保持一致 */
function logLabelKey(prefix: string, value: string): string {
  return `${prefix}${value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
}

/** `auth.refresh.failed.<reason>` 由日志中心拆成「动作 + 原因」两段渲染 */
const REFRESH_FAILED_PREFIX = 'auth.refresh.failed.';

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(abs, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(abs);
  }
  return out;
}

interface LabelGroup {
  /** 出问题时打印给人看的类别名 */
  label: string;
  prefix: string;
  values: Set<string>;
}

/**
 * 从 `src/` 扫出日志中心会拿去查标签的四类值。
 *
 * 只扫生产代码：`scripts/` 与 webapp 测试自己也会写这些字面量，混进来会互相干扰。
 */
function collectLabelGroups(): LabelGroup[] {
  const actions = new Set<string>();
  const reasons = new Set<string>();
  const triggers = new Set<string>();
  const targetTypes = new Set<string>();
  const root = path.resolve(import.meta.dirname, '../..');

  for (const file of collectSourceFiles(path.join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    // `action: '...'` / `action: someVariable`（再回头找同文件里的赋值）/ 位置参数式调用
    for (const m of source.matchAll(/action:\s*'([^']+)'/g)) actions.add(m[1]);
    for (const m of source.matchAll(/action:\s*([A-Za-z_$][\w$]*)/g)) {
      for (const a of source.matchAll(new RegExp(`\\b${m[1]}\\s*=\\s*'([^']+)'`, 'g'))) actions.add(a[1]);
    }
    for (const m of source.matchAll(/write\w*Audit\w*\(\s*storage\s*,\s*[^,]+,\s*'([^']+)'/g)) actions.add(m[1]);
    for (const m of source.matchAll(/reason:\s*'([^']+)'/g)) reasons.add(m[1]);
    for (const m of source.matchAll(/trigger:\s*'([^']+)'/g)) triggers.add(m[1]);
    for (const m of source.matchAll(/targetType:\s*'([^']+)'/g)) targetTypes.add(m[1]);
  }

  for (const action of [...actions]) {
    if (action.startsWith(REFRESH_FAILED_PREFIX)) {
      reasons.add(action.slice(REFRESH_FAILED_PREFIX.length));
      actions.delete(action);
    }
  }

  return [
    { label: '动作', prefix: 'txt_log_action_', values: actions },
    { label: '原因', prefix: 'txt_log_reason_', values: reasons },
    { label: '触发方式', prefix: 'txt_log_trigger_', values: triggers },
    { label: '目标类型', prefix: 'txt_log_target_type_', values: targetTypes },
  ];
}

test('日志中心用到的每个值，在全部语言包都有标签（扫不到时也要红，防止护栏自己失效）', async () => {
  const groups = collectLabelGroups();

  // 先确认扫描本身没坏：数量明显偏少说明正则失效了，此时「无缺失」是假阳性
  const expectedAtLeast: Record<string, number> = {
    txt_log_action_: 30,
    txt_log_reason_: 10,
    txt_log_trigger_: 3,
    txt_log_target_type_: 8,
  };
  for (const group of groups) {
    assert.ok(
      group.values.size >= expectedAtLeast[group.prefix],
      `扫描 ${group.label} 只拿到 ${group.values.size} 个值（预期 ≥ ${expectedAtLeast[group.prefix]}），正则可能已失效`
    );
  }

  const missing: string[] = [];
  for (const { value: locale } of AVAILABLE_LOCALES) {
    await setLocale(locale);
    for (const group of groups) {
      for (const value of group.values) {
        const key = logLabelKey(group.prefix, value);
        if (t(key) === key) missing.push(`${locale} 缺 ${key}（${group.label}：${JSON.stringify(value)}）`);
      }
    }
  }
  // 换回英文，免得影响同文件里后面的用例
  await setLocale('en');

  assert.deepEqual(missing, []);
});

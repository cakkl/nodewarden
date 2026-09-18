// webapp 纯逻辑测试：i18n 插值与「服务端错误串 → 文案」的映射（§3.5 方案 A）
//
// 为什么值得测：这两件事都是**静默失败**型的 ——
//   · 插值缺参数会变成空字符串，页面上就是一个说不通的句子，而不是报错；
//   · `translateServerError` 映射不到时会**回退成原始英文串**，于是非英文用户
//     会突然看到一句英文。这类问题很难在 UI 走查里发现（除非恰好用非英文界面复现那条错误）。
//
// 注意：`webapp/src/lib/i18n.ts` 在模块加载时就把 `activeMessages` 初始化为英文语言包，
// 且 locale 探测包在 try/catch 里，因此**在 Node 里可直接使用，无需 DOM 桩、无需 initI18n()**。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { AVAILABLE_LOCALES, getLocale, t, translateServerError } from '../../webapp/src/lib/i18n';
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
// 映射不到时管理员会直接看到这串英文（非英文界面下尤其刺眼），
// 而“毫秒 / 秒”换算写错时界面会出现「15000 秒」这种读数 —— 两者都是静默失败。
// ⚠️ 样例**必须**用共享构造器生成（`shared/backup-timeout-message.ts`）：
// 手写字符串的话，后端改措辞时这里会继续绿，而用户那边已经退回英文原文。
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

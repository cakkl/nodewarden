// webapp 纯逻辑测试：「用户级偏好」客户端（lib/api/preferences.ts）的请求契约。
//
// demo 模式没有后端（偏好查询被 `IS_DEMO_MODE` 禁用），URL、方法、字段名写错时本地怎么点都
// 发现不了 —— 真机上表现为「语言选了没落库」「时区清不掉」，而且不报错。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectPreferences, savePreferences } from '../../webapp/src/lib/api/preferences';
import type { AuthedFetch } from '../../webapp/src/lib/api/shared';

interface CapturedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** 记录调用并返回固定响应的假 `authedFetch`。 */
function stubFetch(payload: unknown, status = 200): { calls: CapturedCall[]; authedFetch: AuthedFetch } {
  const calls: CapturedCall[] = [];
  const authedFetch: AuthedFetch = async (input, init) => {
    const raw = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url: input, method: init?.method ?? 'GET', body: raw ? JSON.parse(raw) : null });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, authedFetch };
}

test('detect：POST 到 detect 端点，并原样带上浏览器检测值', async () => {
  const { calls, authedFetch } = stubFetch({
    locale: 'zh-CN',
    autoLocale: true,
    timezone: 'Asia/Shanghai',
    autoTimezone: true,
    localeWritten: true,
    timezoneWritten: true,
  });

  const result = await detectPreferences(authedFetch, { locale: 'zh-CN', timezone: 'Asia/Shanghai' });

  assert.deepEqual(calls, [
    {
      url: '/api/accounts/preferences/detect',
      method: 'POST',
      body: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    },
  ]);
  assert.deepEqual(result, {
    locale: 'zh-CN',
    autoLocale: true,
    timezone: 'Asia/Shanghai',
    autoTimezone: true,
    localeWritten: true,
    timezoneWritten: true,
  });
});

test('detect：返回值以**服务端**为准，并如实带上两次 write 标记', async () => {
  // 用户已手动选定 de / Europe-Berlin，本次浏览器报的是 zh-CN / Asia-Shanghai：
  // 服务端不覆盖，返回它自己的值 + written=false。客户端必须照实回显，否则界面会闪成浏览器值。
  const { authedFetch } = stubFetch({
    locale: 'de',
    autoLocale: false,
    timezone: 'Europe/Berlin',
    autoTimezone: false,
    localeWritten: false,
    timezoneWritten: false,
  });

  const result = await detectPreferences(authedFetch, { locale: 'zh-CN', timezone: 'Asia/Shanghai' });

  assert.equal(result.locale, 'de');
  assert.equal(result.timezone, 'Europe/Berlin');
  assert.equal(result.localeWritten, false, 'false = 服务端没有覆盖手动值，界面据此不必提示');
  assert.equal(result.timezoneWritten, false);
});

test('detect：空串与缺失字段归一成 null（不让空串冒充「已设定」）', async () => {
  const { authedFetch } = stubFetch({
    locale: '   ',
    timezone: '',
    autoLocale: 0,
    autoTimezone: 1,
    localeWritten: 0,
  });

  const result = await detectPreferences(authedFetch, {});

  assert.equal(result.locale, null, '纯空白的语言必须归一成「未设定」');
  assert.equal(result.timezone, null);
  assert.equal(result.autoLocale, false);
  assert.equal(result.autoTimezone, true, '真值转换（1 → true）');
  assert.equal(result.localeWritten, false);
  assert.equal(result.timezoneWritten, false, '字段缺失时按 false，不能是 undefined');
});

test('save：PUT 到 preferences 端点，显式 null 必须保留（清空回未设定的语义）', async () => {
  const { calls, authedFetch } = stubFetch({
    locale: null,
    autoLocale: false,
    timezone: null,
    autoTimezone: false,
  });

  const result = await savePreferences(authedFetch, { locale: null, timezone: null });

  assert.deepEqual(calls[0], {
    url: '/api/accounts/preferences',
    method: 'PUT',
    body: { locale: null, timezone: null },
  });
  assert.equal(result.locale, null);
});

test('save：只传一个字段时不动另一个（省略 = 不改）', async () => {
  const { calls, authedFetch } = stubFetch({
    locale: 'en',
    autoLocale: true,
    timezone: 'UTC',
    autoTimezone: false,
  });

  await savePreferences(authedFetch, { localeAuto: true, locale: 'en' });

  assert.deepEqual(calls[0].body, { localeAuto: true, locale: 'en' });
  assert.equal('timezone' in (calls[0].body || {}), false, '未提及的字段不得出现在请求体里');
});

test('非 2xx：抛出服务端描述（否则用户只看到「什么都没发生」）', async () => {
  const { authedFetch } = stubFetch({ error: 'unsupported timezone' }, 400);

  await assert.rejects(
    () => detectPreferences(authedFetch, { timezone: 'Not/AZone' }),
    /unsupported timezone/
  );
});

test('非 2xx 且响应体为空：用本功能的兜底文案（护栏：该键必须真实存在）', async () => {
  // t() 找不到键时会**原样返回键名**，所以这里断言的是英文文案而不是键名 ——
  // 一旦有人删掉 txt_preferences_load_failed，这条会红。
  const { authedFetch } = stubFetch({}, 500);

  await assert.rejects(() => detectPreferences(authedFetch, { locale: 'en' }), /Failed to load preferences/);
  await assert.rejects(() => savePreferences(authedFetch, { locale: 'en' }), /Failed to save preferences/);
});

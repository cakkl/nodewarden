// webapp 纯逻辑测试：按用户偏好格式化时间（见 docs/TODO/MAIL-PREFS.md）。
//
// 这类格式化是**静默出错**的：时区没生效不会报错，只是把时间显示成另一个时区的值；
// 本机时区恰好等于预期时区时，在 UI 走查里看不出来。这里用确定的 UTC 瞬间做硬断言。
//
// 只 import 纯函数 `formatDateTimeInPrefs`：`datetime.ts` 里的 hook 依赖 preact。
// 断言只用稳定选项（2 位小时 + hour12:false），避免 Intl 的标点/顺序差异让测试变脆。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_DATE_TIME_PREFS, formatDateTimeInPrefs } from '../../webapp/src/lib/datetime';

/** 2026-09-22 15:45 UTC */
const INSTANT = '2026-09-22T15:45:00.000Z';
const HOUR_ONLY: Intl.DateTimeFormatOptions = { hour: '2-digit', hour12: false };

function hourIn(timezone: string | null): string | null {
  return formatDateTimeInPrefs(INSTANT, { locale: 'en-US', timezone }, HOUR_ONLY);
}

test('按偏好时区换算：UTC+8 ⇒ 23 点，UTC ⇒ 15 点，纽约夏令时 ⇒ 11 点', () => {
  assert.equal(hourIn('Asia/Shanghai'), '23');
  assert.equal(hourIn('UTC'), '15');
  assert.equal(hourIn('America/New_York'), '11');
});

test('未设定时区 ⇒ 退回**浏览器时区**（与引入本机制前的观感一致）', () => {
  const browserHour = new Intl.DateTimeFormat('en-US', HOUR_ONLY).format(new Date(INSTANT));
  assert.equal(hourIn(null), browserHour);
});

test('库里存了非法时区名 ⇒ 退回浏览器时区而不是抛错', () => {
  const browserHour = new Intl.DateTimeFormat('en-US', HOUR_ONLY).format(new Date(INSTANT));
  assert.equal(hourIn('Not/AZone'), browserHour);
  assert.equal(hourIn(''), browserHour);
});

test('空值 / 无法解析 ⇒ 返回 null（兜底交给调用方，因为各处不一样）', () => {
  assert.equal(formatDateTimeInPrefs(null, DEFAULT_DATE_TIME_PREFS), null);
  assert.equal(formatDateTimeInPrefs(undefined, DEFAULT_DATE_TIME_PREFS), null);
  assert.equal(formatDateTimeInPrefs('', DEFAULT_DATE_TIME_PREFS), null);
  assert.equal(formatDateTimeInPrefs('not-a-date', DEFAULT_DATE_TIME_PREFS), null);
});

test('接受 Date / 数字时间戳 / ISO 串三种输入', () => {
  // 注意 locale 必须显式给：不给就按**运行环境**的默认语言格式化
  //（本机 Node 会输出「23时」这类本地化写法，断言会跟着环境漂）
  const prefs = { locale: 'en-US', timezone: 'Asia/Shanghai' };
  const fromDate = formatDateTimeInPrefs(new Date(INSTANT), prefs, HOUR_ONLY);
  const fromNumber = formatDateTimeInPrefs(Date.parse(INSTANT), prefs, HOUR_ONLY);
  const fromString = formatDateTimeInPrefs(INSTANT, prefs, HOUR_ONLY);
  assert.equal(fromDate, '23');
  assert.equal(fromNumber, '23', '数字时间戳（PasswordSecurityPage 就是传 number）必须能解析');
  assert.equal(fromString, '23');
});

test('偏好语言会影响格式（月份名）', () => {
  const options: Intl.DateTimeFormatOptions = { month: 'long', timeZone: 'UTC' };
  const english = formatDateTimeInPrefs(INSTANT, { locale: 'en-US', timezone: 'UTC' }, options);
  const chinese = formatDateTimeInPrefs(INSTANT, { locale: 'zh-CN', timezone: 'UTC' }, options);
  assert.equal(english, 'September');
  assert.equal(chinese, '九月');
});

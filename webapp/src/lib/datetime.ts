/**
 * 时间显示相关的共享工具。
 *
 * 时区由用户偏好决定（设置 → 偏好），所以格式化统一走这里 —— 各处直接调 `toLocaleString()`
 * 会隐含使用浏览器时区，让「用户设定的时区」失效。
 *
 * 分两层：纯函数 `formatDateTimeInPrefs()`（可单测、可在非组件代码里用）与
 * `useDateTimeFormat()` hook（从 Context 取偏好并绑定成格式化函数）。
 */
import { createContext } from 'preact';
import { useContext, useMemo } from 'preact/hooks';

/** 用户级时间显示偏好。`null` = 未设定。 */
export interface DateTimePrefs {
  locale: string | null;
  timezone: string | null;
}

/** 未设定：`timezone` 为空时退回**浏览器时区**。 */
export const DEFAULT_DATE_TIME_PREFS: DateTimePrefs = { locale: null, timezone: null };

/** 没挂 Provider 时的兜底（例如独立渲染的页面），等于「未设定」。 */
export const DateTimePrefsContext = createContext<DateTimePrefs>(DEFAULT_DATE_TIME_PREFS);

/** 库里可能存着历史手工改坏的值 ⇒ 格式化前先探一下，非法就退回浏览器时区。 */
function safeTimeZone(value: string | null): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/**
 * 按偏好格式化时间。
 *
 * **解析失败返回 `null`**，兜底交给调用方 —— 因为各处本来就不一样：
 * 有的显示 `-`、有的原样回显、有的显示空串，统一兜底会改变既有行为。
 *
 * `options` 不传时等价于原来的 `toLocaleString()`（日期 + 时间，按语言换格式）。
 */
export function formatDateTimeInPrefs(
  value: unknown,
  prefs: DateTimePrefs = DEFAULT_DATE_TIME_PREFS,
  options?: Intl.DateTimeFormatOptions
): string | null {
  if (value === null || value === undefined || value === '') return null;
  // 不能先 `String(value)`：那样数字时间戳会变成 `"1758…"` 这种串，`new Date()` 解不出来。
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) return null;
  const timezone = safeTimeZone(prefs.timezone);
  return new Intl.DateTimeFormat(prefs.locale || undefined, {
    ...(options ?? {}),
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(date);
}

/**
 * 组件里用这个：拿到与**当前用户偏好**绑定好的格式化函数。
 *
 * 用法（保持各文件原有 helper 的形状，调用点几乎不用改）：
 * ```ts
 * const { format } = useDateTimeFormat();
 * const formatDateTime = (value: string | null | undefined) => format(value) ?? t('txt_dash');
 * ```
 */
export function useDateTimeFormat(): {
  prefs: DateTimePrefs;
  format: (value: unknown, options?: Intl.DateTimeFormatOptions) => string | null;
} {
  const prefs = useContext(DateTimePrefsContext);
  const { locale, timezone } = prefs;
  const format = useMemo(
    () => (value: unknown, options?: Intl.DateTimeFormatOptions) =>
      formatDateTimeInPrefs(value, { locale, timezone }, options),
    [locale, timezone]
  );
  return { prefs, format };
}

/**
 * 浏览器所在时区；拿不到就回退 UTC。
 *
 * 与代理 / 网络无关（来自操作系统与浏览器设置），但会被指纹防护固定成 UTC
 *（Firefox 严格模式 `privacy.resistFingerprinting`）。
 */
export function detectBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

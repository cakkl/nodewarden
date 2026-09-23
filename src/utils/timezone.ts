/**
 * IANA 时区名校验 —— 全仓库唯一实现。
 *
 * 让 ICU 真的构造一次格式化器：不认得的名字会抛 `RangeError`。
 *
 * 只回答「这个名字 ICU 认不认得」：空值语义（清空 / 未设定 / 回退 UTC）由调用方自己决定。
 */
export function isValidTimeZone(value: unknown): value is string {
  const timezone = typeof value === 'string' ? value.trim() : '';
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

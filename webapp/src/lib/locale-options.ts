import { AVAILABLE_LOCALES, type Locale } from '@/lib/i18n';

/**
 * 语言下拉的选项顺序：①「自动」由调用方渲染 → ② 探测出的语言 → ③ 其余按 `AVAILABLE_LOCALES` 原顺序，
 * 探测项不在 ③ 里重复（重复的 `<option value>` 会让选中态错乱）。
 *
 * 标签用语言自己的写法（`AVAILABLE_LOCALES[].label`），不按当前界面语言翻译：
 * 英文界面下用户未必认识 `Chinese (Simplified)`，但一定认得出自己的 `简体中文`。
 */
export function buildLocaleOptions(detected: Locale): { value: Locale; label: string }[] {
  const detectedOption = AVAILABLE_LOCALES.find((option) => option.value === detected);
  if (!detectedOption) return [...AVAILABLE_LOCALES];
  return [detectedOption, ...AVAILABLE_LOCALES.filter((option) => option.value !== detected)];
}

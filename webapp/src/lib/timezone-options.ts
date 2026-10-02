/**
 * 时区下拉的选项：①「自动」由调用方渲染 → ② 探测到的时区单独一条 → ③ 其余按 IANA 地区分组
 * （组内沿用 ICU 给的字母序），文本带偏移注释（`Asia/Shanghai (UTC+8)`）。
 *
 * ⚠️ 偏移只当注释、不当排序键：418 项里两种排法的定位距离同量级（`Asia/Shanghai` 第 272 vs 第 358），
 * 而偏移序还会随夏令时漂（`Europe/London` 一月第 186、七月第 200）。
 */
export interface TimezoneOption {
  value: string;
  label: string;
}

export interface TimezoneGroup {
  region: string;
  options: TimezoneOption[];
}

/** 同一时区的偏移在页面停留期间不会变，formatter 复用一个就够（418 项重建要 ~40 ms） */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** `Asia/Shanghai` → `UTC+8`；取不到时返回空串（调用方退回只显示时区名，不要拼出空括号） */
function offsetLabel(zone: string): string {
  try {
    let formatter = offsetFormatters.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' });
      offsetFormatters.set(zone, formatter);
    }
    const name = formatter.formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value || '';
    // ICU 给的是 `GMT+8` 这种写法，统一成 `UTC+8`
    return name.replace(/^GMT/, 'UTC');
  } catch {
    return '';
  }
}

export function formatTimezoneOption(zone: string): TimezoneOption {
  const offset = offsetLabel(zone);
  return { value: zone, label: offset ? `${zone} (${offset})` : zone };
}

export function buildTimezoneGroups(
  zones: readonly string[],
  detected: string
): { detectedOption: TimezoneOption | null; groups: TimezoneGroup[] } {
  // 探测值可能不在列表里（`Intl.supportedValuesOf('timeZone')` 不含 `UTC`，而探测失败的兜底正是 'UTC'）
  const detectedOption = zones.includes(detected) ? formatTimezoneOption(detected) : null;

  // 分组：`America/Argentina/Buenos_Aires` 这类只取第一段；组内顺序沿用传入顺序（ICU 已是字母序）
  const byRegion = new Map<string, TimezoneOption[]>();
  for (const zone of zones) {
    if (zone === detected) continue; // 探测项已单独一条，不在分组里重复出现
    const separator = zone.indexOf('/');
    const region = separator > 0 ? zone.slice(0, separator) : 'UTC';
    const options = byRegion.get(region);
    if (options) options.push(formatTimezoneOption(zone));
    else byRegion.set(region, [formatTimezoneOption(zone)]);
  }

  return {
    detectedOption,
    groups: Array.from(byRegion, ([region, options]) => ({ region, options })),
  };
}

/**
 * 标签输入的候选筛选（仅 Web）。
 * 标签本身**大小写敏感**（`Prod` ≠ `prod`），但**匹配**忽略大小写 —— 输入 `prod` 也该看到 `Prod`。
 */
export function filterTagSuggestions(options: readonly string[], query: string): string[] {
  const trimmed = query.trim();
  // 空输入给全部候选：这不是「自动补全」而是「省去手敲」，点一下即填
  if (!trimmed) return [...options];

  const needle = trimmed.toLocaleLowerCase();
  const matches = options.filter((option) => option.toLocaleLowerCase().includes(needle));
  // 已经逐字填好（唯一候选且相等）就不再提示：面板上挂一个与自己一样的候选只是碍事
  if (matches.length === 1 && matches[0].toLocaleLowerCase() === needle) return [];
  return matches;
}

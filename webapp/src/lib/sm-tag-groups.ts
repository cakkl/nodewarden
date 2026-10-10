/**
 * 按标签给机密列表分组（仅 Web；标签是本站扩展字段）。
 *
 * - **分组从传进来的条目聚合**（调用方传已筛选列表）⇒ 结构上不可能出现「空组」；
 * - 组间按标签名（`localeCompare`）、组内保持传入顺序；
 * - 无标签的条目不参与分组，单独回给调用方置底。
 *
 * 标签大小写敏感（`Prod` ≠ `prod`）；唯一做的卫生处理是两端 `trim`。
 */
export interface SecretTagGroup<T> {
  tag: string;
  items: T[];
}

export function groupSecretsByTag<T extends { id: string }>(
  items: readonly T[],
  tagsBySecretId: Record<string, string>
): { groups: Array<SecretTagGroup<T>>; untagged: T[] } {
  const buckets = new Map<string, T[]>();
  const untagged: T[] = [];
  for (const item of items) {
    const tag = (tagsBySecretId[item.id] ?? '').trim();
    if (!tag) {
      untagged.push(item);
      continue;
    }
    const bucket = buckets.get(tag);
    if (bucket) bucket.push(item);
    else buckets.set(tag, [item]);
  }
  return {
    groups: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, bucketItems]) => ({ tag, items: bucketItems })),
    untagged,
  };
}

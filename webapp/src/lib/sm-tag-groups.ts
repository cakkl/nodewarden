/**
 * 按标签给机密列表分组（仅 Web；标签是本站扩展字段）。
 *
 * 三条规则：
 * - **分组来源是传进来的条目本身**（调用方传的是已筛选列表）⇒ 结构上不可能出现「空组」；
 * - 组间按标签名排（`localeCompare`，中文等非 ASCII 也合理）；组内保持传入顺序（调用方的排序）；
 * - 没有标签的条目**不参与分组**，单独回给调用方放到最下面。
 *
 * 标签大小写敏感（`Prod` 与 `prod` 是两个组）—— 服务端不做归一化，这里也不做，
 * 唯一做的卫生处理是两端 `trim`（手滑多一个空格不该凭空多出一个分组）。
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

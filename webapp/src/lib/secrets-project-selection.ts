/**
 * 「调整所属项目」的勾选语义（多选时**逐项目三态 + 增量**）。
 * ⚠️ 不能把所选机密的项目集当成一个整体替换：各条归属可能不同，而用户**没动过的项目必须保持
 * 各条原样**（只有 A 属于 B、没碰 B ⇒ 仍然只有 A 属于 B）。只有动过的项目才统一增删。
 */
export interface ProjectToggledSecret {
  id: string;
  projectIds: readonly string[];
}

/** 每个项目的三态：`true` 全勾、`false` 不勾、`'partial'` 半勾（部分机密属于它）。 */
export type ProjectCheckState = true | false | 'partial';

/** 用户动过的项目：`projectId → 勾选后的状态`（未出现在表里 = 没动过）。 */
export type ProjectToggles = ReadonlyMap<string, boolean>;

export function projectCheckState(
  selected: ReadonlyArray<ProjectToggledSecret>,
  projectId: string,
  toggles: ProjectToggles
): ProjectCheckState {
  const forced = toggles.get(projectId);
  if (forced !== undefined) return forced;
  const count = selected.filter((secret) => secret.projectIds.includes(projectId)).length;
  if (count === 0) return false;
  if (count === selected.length) return true;
  return 'partial';
}

/** 把「动过的项目」套到每条机密上（其余项目保持各条原样）。 */
export function applyProjectToggles(
  selected: ReadonlyArray<ProjectToggledSecret>,
  toggles: ProjectToggles
): Array<{ id: string; projectIds: string[] }> {
  return selected.map((secret) => {
    const next = new Set(secret.projectIds);
    for (const [projectId, checked] of toggles) {
      if (checked) next.add(projectId);
      else next.delete(projectId);
    }
    return { id: secret.id, projectIds: [...next] };
  });
}

/**
 * 结果里所有机密的项目集是否**完全一致**；一致时返回该集合（标签可直接显示项目名），
 * 不一致返回 `null`（标签显示「多个项目」）。
 */
export function commonProjectIds(assignments: ReadonlyArray<{ projectIds: readonly string[] }>): string[] | null {
  if (!assignments.length) return [];
  const signature = (ids: readonly string[]): string => [...ids].sort().join(',');
  const first = signature(assignments[0].projectIds);
  if (assignments.some((item) => signature(item.projectIds) !== first)) return null;
  return [...assignments[0].projectIds];
}

/**
 * 令牌「还能不能用」的判定（仅 Web 展示用）。
 *
 * 失效两条路径，口径**必须与服务端一致**（`src/handlers/secrets-token.ts` 换 token 时两者都拒）：
 * 撤销写 `revoked_at`；过期看 `expires_at <= now`（服务端到点即拒，但**不**回写标记）。
 * ⚠️ 只看 `revokedAt` 不够：过期令牌会一直躺在有效区，还顶着一个过去的到期日。
 */
export type TokenInactiveReason = 'revoked' | 'expired';

/** 失效原因；可用则返回 `null`。`now` 由调用方传入（一次渲染共用一个时刻，也便于测试）。 */
export function tokenInactiveReason(
  token: { revokedAt: string | null; expiresAt: string },
  now: number
): TokenInactiveReason | null {
  if (token.revokedAt) return 'revoked';
  // ⚠️ `<=`：与服务端同一口径（那一刻起就已经换不到令牌了）
  if (token.expiresAt && Date.parse(token.expiresAt) <= now) return 'expired';
  return null;
}

/** 拆成「可用 / 已失效」两批，各自保持传入顺序。 */
export function splitTokensByUsable<T extends { revokedAt: string | null; expiresAt: string }>(
  items: readonly T[],
  now: number
): { active: T[]; inactive: T[] } {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const item of items) {
    if (tokenInactiveReason(item, now)) inactive.push(item);
    else active.push(item);
  }
  return { active, inactive };
}

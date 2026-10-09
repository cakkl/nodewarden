import type { Env } from '../types';
import { purgeExpiredSecrets } from './storage-secrets-repo';

/**
 * Trash 保留期：软删后满 30 天才物理清除。
 *
 * ⚠️ 这是**我们自己的策略**，密码库的回收站并**没有**自动清理（它永久保留，只能手动永久删除）。
 * 两者不一致是有意的：机密是给程序读的，过期不清理会让「已废弃的凭据」长期留在库里。
 */
export const SECRETS_TRASH_RETENTION_DAYS = 30;

/**
 * 清除满期的 Trash，返回清除条数。由每 5 分钟的 scheduled 调用。
 *
 * 一条 `deleted_at < cutoff` 就能扫全库满期行，不需要按组织遍历。
 */
export async function purgeSecretsTrash(env: Env, nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - SECRETS_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return purgeExpiredSecrets(env.DB, cutoff);
}

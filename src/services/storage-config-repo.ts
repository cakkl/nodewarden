export async function isRegistered(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind('registered').first<{ value: string }>();
  return row?.value === 'true';
}

export async function getConfigValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  return typeof row?.value === 'string' ? row.value : null;
}

export async function setConfigValue(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

export async function setRegistered(db: D1Database): Promise<void> {
  await db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind('registered', 'true')
    .run();
}

/**
 * 「先写后判」的原子认领：只有候选值与库中现值**不同**时才真正写入，返回本次调用是否**赢得了这次变更**。
 *
 * 为什么不能写成「先读 → 比较 → 再写」：并发调用（多个 isolate 同时冷启动）会读到同样的旧值、都以为
 * “变了”，于是重复执行后续动作（例如重复写一条审计日志）。这里把判断挪进同一条 SQL，D1 又是单写者，
 * 因此并发的重复调用里只有一个能拿到 `meta.changes === 1`，其余拿到 0。
 */
export async function claimConfigValue(db: D1Database, key: string, value: string): Promise<boolean> {
  const result = await db
    .prepare(
      'INSERT INTO config(key, value) VALUES(?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE config.value <> excluded.value'
    )
    .bind(key, value)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

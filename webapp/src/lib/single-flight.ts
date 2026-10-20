/**
 * 单飞（single-flight）执行器：同一时刻只跑一个任务，在途时后续调用**直接丢弃**（不排队）。
 *
 * ⚠️ 判定必须在**同步**路径上：`disabled` 由 state 驱动、要等下一轮 render 才生效，
 * 而双击的第二次 click 可能赶在那之前到达 ⇒ 两次写请求都落到服务端；服务端多数没有
 * 幂等键（例：官方 secrets 创建项目）⇒ 一次点击变两条记录。
 */
export interface SingleFlight {
  /** 任务进行中时为 true（同步可见）。 */
  readonly active: boolean;
  /** 在途时返回 `null` 且**不执行**任务；否则返回任务结果（失败照常抛出）。 */
  run<T>(task: () => Promise<T>): Promise<T | null>;
  /**
   * 同步占位：拿到返回 true，在途返回 false。
   * ⚠️ 拿到之后**必须**在 `finally` 里 `release()`，否则后续写操作会被永久拦掉。
   */
  tryEnter(): boolean;
  /** 释放占位（幂等）。 */
  release(): void;
}

export function createSingleFlight(): SingleFlight {
  let active = false;

  const tryEnter = (): boolean => {
    if (active) return false;
    active = true;
    return true;
  };
  const release = (): void => {
    active = false;
  };

  return {
    get active(): boolean {
      return active;
    },
    tryEnter,
    release,
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      if (!tryEnter()) return null;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * 按**操作类型**分配门闩：同类互斥、异类可并行。
 * ⚠️ 不能退化成全局一把：双击的两次请求必然同类型，按类型已足够挡重复，又不会让
 * 「保存机密」把「删除项目」误伤成静默无反应。
 */
export interface SingleFlightRegistry<K extends string> {
  gate(key: K): SingleFlight;
}

export function createSingleFlightRegistry<K extends string>(): SingleFlightRegistry<K> {
  const gates = new Map<K, SingleFlight>();
  return {
    gate(key: K): SingleFlight {
      const existing = gates.get(key);
      if (existing) return existing;
      const created = createSingleFlight();
      gates.set(key, created);
      return created;
    },
  };
}

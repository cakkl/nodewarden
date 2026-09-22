// 备份 / 恢复的进度上报：**尽力而为**，绝不能决定业务操作的成败。
//
// CONTRACT：
//   1. 调用方上报进度**必须**走 `reportProgress()`，不要直接 `await reporter(event)`。
//   2. 进度回调的**实现**应当自行吞掉异常（两道都要有，缺一不可）。
//
// 起因是恢复路径的真实事故：那里的回调会 `touchLease()` 续 DO 租约、而这一步会抛，裸 `await`
// 于是让「完成」通知的异常被外层 catch 报成 500（数据其实已换好），或让「失败」通知覆盖掉原始
// 失败原因。收敛到这里之后，「上报不得决定业务成败」从约定变成了代码事实。

/**
 * 进度回调。实现**应当**自行吞掉异常；即便如此，调用点也必须走 `reportProgress()`。
 */
export type BackupProgressReporter<Event> = (event: Event) => Promise<void> | void;

/** 尽力而为地上报一次进度：失败只记 console，绝不外抛、绝不改变调用方的控制流。 */
export async function reportProgress<Event>(
  reporter: BackupProgressReporter<Event> | undefined | null,
  event: Event
): Promise<void> {
  try {
    await reporter?.(event);
  } catch (error) {
    console.error('Backup progress reporting failed (ignored):', error);
  }
}

// 备份 / 恢复的进度上报：**尽力而为**，绝不能决定业务操作的成败。
//
// CONTRACT：
//   1. 调用方上报进度**必须**走 `reportProgress()`，不要直接 `await reporter(event)`。
//   2. 进度回调的**实现**应当自行吞掉异常（例如 `notifyUserBackupProgress()` 内部就是
//      try/catch）。第 1 条正是为了在实现违反第 2 条时兜住 —— 两道都要有，缺一不可。
//
// 为什么需要这个模块（真实事故，见 handlers/backup.ts 的恢复路径）：那里的进度回调会先
// `touchLease()` 去续 Durable Object 的作业租约，而这一步**会抛**（DO 不可用、作业已过期等）。
// 当时调用点写的是裸 `await progress?.(...)`，于是：
//   - `swapShadowTablesIntoPlace()` **之后**的「完成」通知抛错 ⇒ 交换已提交、恢复其实成功了，
//     异常却被外层 catch 捕获并对外报 500（用户以为失败，数据其实已经换掉）；
//   - catch 分支里的「失败」通知抛错 ⇒ 把原始的失败原因覆盖掉，排障时看不到真因。
//
// 导出 / 远端备份那 10 处当时没爆，只是因为它们的回调恰好只发通知、而
// `notifyUserBackupProgress()` 自带 try/catch —— 也就是说那些地方的安全性是**偶然**的，
// 依赖一条没写下来的约定。而一旦有人给备份回调也加上 `touchLease()`（恢复路径就是这么写的），
// 同一条语句会变成：远端「verify 前」的上报抛错被当成**校验失败** ⇒ 进 catch
// `deleteFile()` **删掉刚上传成功的归档**、重试 3 次、最后报「verification failed」
// 并附上通知的错误。这种后果不该由约定来防。
//
// 把上报收敛到这里之后，「进度上报不得决定业务成败」就从约定变成了代码里的事实。

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

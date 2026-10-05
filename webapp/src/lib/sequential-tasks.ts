/**
 * 顺序执行一组带标签的任务，**单个失败不中断其余**，失败收集后返回（`{label, reason}`）。
 * 用于附件这类多文件批量操作：一个文件失败不该让剩下的都不执行（否则用户得整批重做）。
 */

export interface LabeledTask {
  label: string;
  run: () => Promise<void>;
}

export interface TaskFailure {
  label: string;
  reason: string;
}

export async function runSequentialTasks<T extends LabeledTask>(
  tasks: T[],
  onTaskStart?: (task: T) => void
): Promise<TaskFailure[]> {
  const failures: TaskFailure[] = [];
  for (const task of tasks) {
    onTaskStart?.(task);
    try {
      await task.run();
    } catch (error) {
      failures.push({
        label: task.label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

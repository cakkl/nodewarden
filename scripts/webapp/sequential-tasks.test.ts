// `webapp/src/lib/sequential-tasks.ts` 的行为测试
//
// 关键性质：**一个任务失败不中断其余**（附件批量操作里，一个文件失败不该让剩下的都不执行）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { runSequentialTasks } from '../../webapp/src/lib/sequential-tasks';

test('全部成功时不报告失败', async () => {
  const ran: string[] = [];
  const failures = await runSequentialTasks([
    { label: 'a', run: async () => { ran.push('a'); } },
    { label: 'b', run: async () => { ran.push('b'); } },
  ]);
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(failures, []);
});

test('中间一个失败，其余仍然执行且顺序不变', async () => {
  const ran: string[] = [];
  const failures = await runSequentialTasks([
    { label: 'a', run: async () => { ran.push('a'); } },
    { label: 'b', run: async () => { ran.push('b'); throw new Error('boom'); } },
    { label: 'c', run: async () => { ran.push('c'); } },
  ]);
  assert.deepEqual(ran, ['a', 'b', 'c'], '失败的那个不能中断后续任务');
  assert.deepEqual(failures, [{ label: 'b', reason: 'boom' }]);
});

test('多个失败逐个记录，不是只报第一个', async () => {
  const failures = await runSequentialTasks([
    { label: 'a', run: async () => { throw new Error('first'); } },
    { label: 'b', run: async () => { throw new Error('second'); } },
  ]);
  assert.deepEqual(failures.map((failure) => failure.label), ['a', 'b']);
  assert.deepEqual(failures.map((failure) => failure.reason), ['first', 'second']);
});

test('非 Error 的抛出也转成可读文本', async () => {
  const failures = await runSequentialTasks([
    { label: 'a', run: async () => { throw 'plain-string'; } },
  ]);
  assert.equal(failures[0]?.reason, 'plain-string');
});

test('onTaskStart 对每个任务都调用（含失败的那个）—— 上传进度条依赖它', async () => {
  const started: string[] = [];
  await runSequentialTasks(
    [
      { label: 'a.txt', file: { name: 'a.txt' }, run: async () => {} },
      { label: 'b.txt', file: { name: 'b.txt' }, run: async () => { throw new Error('x'); } },
    ],
    (task) => started.push(task.file.name)
  );
  assert.deepEqual(started, ['a.txt', 'b.txt']);
});

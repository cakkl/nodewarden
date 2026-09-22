// 远端备份超时消息的**唯一定义处**。
//
// 这句话同时被三方依赖：
//   ① 后端构造它（`RemoteRequestTimeoutError`，见 `src/services/backup-uploader.ts`）；
//   ② 后端按它判断「是不是超时」⇒ 决定回 **400（不可重试）** 还是 500（500 会被前端
//      `retryableRequest` 自动重试 3 次，把一次超时放大成三倍等待）；
//   ③ 前端按它把消息映射成**本地化文案**（`webapp/src/lib/i18n.ts`，还把毫秒换算成秒）。
//
// 原先 ② 与 ③ 各写了一份正则，任何一侧改措辞另一侧都会**静默失配**；现在三者共用本文件，测试里的
// 样例也由 `buildRemoteTimeoutMessage()` 生成 ⇒ 改一处就会被测试拦住。

/** 远端备份的步骤名。措辞会进用户可见的消息 ⇒ 改动需同步 i18n 映射与测试样例 */
export const REMOTE_REQUEST_ACTIONS = [
  'directory creation',
  'upload',
  'listing',
  'download',
  'delete',
  'existence check',
] as const;

export type RemoteRequestAction = (typeof REMOTE_REQUEST_ACTIONS)[number];

export type RemoteRequestProvider = 'WebDAV' | 'S3';

/**
 * 消息形状的正则**源字符串**（刻意不导出 `RegExp` 对象：
 * 后端只要 `.test()`、前端要用第一个捕获组取毫秒数，各自 `new RegExp(...)` 更清楚）。
 */
export const REMOTE_TIMEOUT_MESSAGE_SOURCE =
  `^(?:WebDAV|S3) (?:${REMOTE_REQUEST_ACTIONS.join('|')}) timed out after (\\d+) ms$`;

/**
 * 共享的正则实例。
 * ⚠️ **不要加 `g` / `y` 标志** —— 那种标志下 `RegExp` 自带 `lastIndex` 状态，
 * 共享同一个实例会让多次调用互相干扰。需要 `i` 之类的容错也请改源字符串，
 * 而不是在调用侧另写一个正则（那就又分叉了）。
 */
export const REMOTE_TIMEOUT_MESSAGE_PATTERN = new RegExp(REMOTE_TIMEOUT_MESSAGE_SOURCE);

/** 构造超时消息（后端唯一的拼装点，测试也用它生成样例） */
export function buildRemoteTimeoutMessage(
  provider: RemoteRequestProvider,
  action: RemoteRequestAction,
  timeoutMs: number
): string {
  return `${provider} ${action} timed out after ${timeoutMs} ms`;
}

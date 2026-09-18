/**
 * 外发请求的超时封装（共用实现）。
 *
 * 为什么必须有：对端「连上了但不回包」时（黑洞 IP、防火墙丢包、被暂停的容器、挂住的
 * TLS 握手），`fetch` 可能**永不 settle** ⇒ 异常永远抛不出来 ⇒ 调用方的 catch 永不执行 ⇒
 * 请求一直挂着，最后由平台兜底返回通用 500（`internal error; reference = …`），
 * 运维只拿到一个引用号，无法自助排查。
 *
 * 约定：包的是**整段操作**（发送请求 + 读响应体）。`fetch` 在收到响应头时就 resolve 了，
 * 「发了头就不再发数据」卡住的正是 `await response.text()` / `arrayBuffer()` 那一步 ——
 * 所以 `run` 里要把读 body 也一起做完（见 `backup-uploader.ts` 的下载路径）。
 */

/** 超时错误。调用方据此区分「超时」与「对端主动失败（如 ECONNREFUSED）」。 */
export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

export function isRequestTimeoutError(error: unknown): error is RequestTimeoutError {
  return error instanceof RequestTimeoutError;
}

/**
 * @param timeoutMs 预算（毫秒）
 * @param run 实际操作；必须把 `signal` 透传给 `fetch`
 * @param controller 需要「两段计时」（先首包、再按体积读 body）时复用同一个 controller
 */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  controller: AbortController = new AbortController()
): Promise<T> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    // 只有我们自己 abort 才会把 signal 置为 aborted；对端主动断开等情况保持原样
    if (controller.signal.aborted) throw new RequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

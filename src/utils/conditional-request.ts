// 条件请求（ETag / If-None-Match）的最小实现，给「只读、会重复请求、内容常不变」的 GET 用。
//
// CONTRACT:
// - ETag 必须来自**现成的版本字段**（如 `updated_at`），不要「先把 body 渲染出来再算内容哈希」——
//   那样 CPU 已经花掉了，304 只剩带宽收益（Worker 按 CPU 计费）。`build` 是 thunk 就是为了钉住这点：
//   命中 304 时它不会被调用。
// - 缓存头必须是 `private, no-cache`（可存、但每次校验）⇒ 浏览器才会发条件请求；
//   `no-store` 是彻底不存，条件请求**永不发生**，等于白做（实测：就这四个字够了）。
// - 304 必须带回同样的 ETag，否则客户端会丢掉已缓存的那份。
import { jsonResponse } from './response';

export const PRIVATE_ALWAYS_REVALIDATE = 'private, no-cache';

/** 弱比较：忽略 `W/` 前缀，另支持逗号列表与 `*` */
const stripWeakPrefix = (value: string): string => value.trim().replace(/^W\//i, '');

export function matchesIfNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get('If-None-Match');
  if (!header) return false;
  const target = stripWeakPrefix(etag);
  return header.split(',').some((candidate) => {
    const value = stripWeakPrefix(candidate);
    return value === '*' || value === target;
  });
}

export function notModifiedResponse(etag: string, cacheControl: string = PRIVATE_ALWAYS_REVALIDATE): Response {
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, 'Cache-Control': cacheControl },
  });
}

/** 命中条件请求回 304（**不调用 `build`**），否则渲染并带上 ETag 回 200 */
export async function conditionalJsonResponse(
  request: Request,
  etag: string,
  build: () => unknown | Promise<unknown>,
  cacheControl: string = PRIVATE_ALWAYS_REVALIDATE
): Promise<Response> {
  if (matchesIfNoneMatch(request, etag)) return notModifiedResponse(etag, cacheControl);
  return jsonResponse(await build(), 200, { ETag: etag, 'Cache-Control': cacheControl });
}

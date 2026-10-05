// 批量端点包装器的契约测试：**必须把服务端交回的条目传出来**
//
// 服务端在批量操作里推进会条目的 revisionDate，客户端只能从响应学到新值 —— 忽略它就滞留旧值。
import assert from 'node:assert/strict';
import test from 'node:test';

import { bulkArchiveCiphers, bulkMoveCiphers, bulkRestoreCiphers, bulkUnarchiveCiphers } from '../../webapp/src/lib/api/vault';
import type { AuthedFetch } from '../../webapp/src/lib/api/shared';

const REVISION = '2026-03-01T00:00:00.001Z';

function stubFetch(ids: string[], calls: { url: string; method?: string }[]): AuthedFetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, name: `enc-${id}`, revisionDate: REVISION })),
        continuationToken: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as AuthedFetch;
}

const CASES = [
  {
    name: '移动',
    path: '/api/ciphers/move',
    run: (fetchImpl: AuthedFetch, ids: string[]) => bulkMoveCiphers(fetchImpl, ids, null),
  },
  {
    name: '归档',
    path: '/api/ciphers/archive',
    run: (fetchImpl: AuthedFetch, ids: string[]) => bulkArchiveCiphers(fetchImpl, ids),
  },
  {
    name: '取消归档',
    path: '/api/ciphers/unarchive',
    run: (fetchImpl: AuthedFetch, ids: string[]) => bulkUnarchiveCiphers(fetchImpl, ids),
  },
  {
    name: '恢复',
    path: '/api/ciphers/restore',
    run: (fetchImpl: AuthedFetch, ids: string[]) => bulkRestoreCiphers(fetchImpl, ids),
  },
] as const;

for (const testCase of CASES) {
  test(`批量${testCase.name}：把服务端返回的条目交给调用方（含新 revisionDate）`, async () => {
    const calls: { url: string; method?: string }[] = [];
    const updated = await testCase.run(stubFetch(['cipher-1', 'cipher-2'], calls), ['cipher-1', 'cipher-2']);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, testCase.path);
    assert.deepEqual(updated.map((cipher) => cipher.id), ['cipher-1', 'cipher-2'], '必须返回服务端交回的条目');
    assert.equal(updated[0]?.revisionDate, REVISION, 'revisionDate 必须来自服务端，不能本地编');
  });
}

test('响应缺少 data 字段时返回空数组（不抛错、不返回 undefined）', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ object: 'list' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as AuthedFetch;
  assert.deepEqual(await bulkMoveCiphers(fetchImpl, ['cipher-1'], null), []);
});

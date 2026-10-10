// 机密详情三级取数：**内存索引（只解密）→ 本地快照（读一次 IndexedDB）→ 网络 `get-by-ids`**。
// 顺序与「加载态放在哪」都不能改：一次 IndexedDB 读就是一个宏任务、够浏览器画出一帧，
// 那是「切换条目先闪一帧加载中」的成因（密码库数据本来就在内存里）。运行：`npm run test:webapp-lib`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const HOOK = 'webapp/src/hooks/useSecretsManager.ts';
const API = 'webapp/src/lib/api/secrets.ts';

/** `loadDetail` 里各关键调用的位置（`await` 形态，避开顶部的 import）。 */
function positions(source: string) {
  return {
    memory: source.indexOf('rawDetailsRef.current.get(id)'),
    snapshot: source.indexOf('await getOfflineSecretDetail('),
    loading: source.indexOf('setSelectedSecretLoading(true)'),
    network: source.indexOf('await getSecretsByIds('),
  };
}

const hookSource = readSource(HOOK);
const apiSource = readSource(API);
const at = positions(hookSource);

/** 三级齐备、顺序正确、且加载态落在网络那一支里。缺任何一项都算不合格。 */
function orderIsCorrect(source: string): boolean {
  const p = positions(source);
  return (
    p.memory > 0 &&
    p.snapshot > 0 &&
    p.loading > 0 &&
    p.network > 0 &&
    p.memory < p.snapshot &&
    p.snapshot < p.loading &&
    p.loading < p.network
  );
}

test('loadDetail 三级顺序：内存索引 → 本地快照 → 网络', () => {
  assert.ok(at.memory > 0, `没在 ${HOOK} 里找到内存索引的读取（改名了就要更新这条护栏）`);
  assert.ok(at.snapshot > 0, `没在 ${HOOK} 里找到本地快照的读取`);
  assert.ok(at.network > 0, `没在 ${HOOK} 里找到 getSecretsByIds 的调用`);
  assert.ok(at.memory < at.snapshot, '内存索引要排在本地快照前：命中它就不必再读一次 IndexedDB');
  assert.ok(at.snapshot < at.network, '本地快照要排在网络前：命中它就不该有等待');
});

test('加载态只在真要走网络时才点亮', () => {
  assert.ok(at.loading > 0, '没找到 setSelectedSecretLoading(true)');
  assert.ok(
    at.snapshot < at.loading && at.loading < at.network,
    'setSelectedSecretLoading(true) 必须留在网络那一支里：提到函数开头会让每次' +
      '「内存 / 快照命中」也先画一帧「加载中」（密码库不是这样的）'
  );
});

test('三级都用「与列表同一版 revisionDate」卡一致性', () => {
  assert.match(hookSource, /raw\.revisionDate === revision/, '内存索引那条要与列表的 revisionDate 一致');
  assert.match(hookSource, /local\.revisionDate === revision/, '本地快照那条同样要一致');
});

test('revision 表随列表同步更新，且索引在快照之后预热', () => {
  const writes = hookSource.match(/setLiveSecrets\(/g) ?? [];
  const remembers = hookSource.match(/rememberRevisions\(listed\.secrets\)/g) ?? [];
  assert.ok(writes.length > 0, '没找到 setLiveSecrets 的调用点');
  assert.equal(
    remembers.length,
    writes.length,
    '每个写入列表的地方都要同步记住 revisionDate（`liveSecrets` 是 state，' +
      'set 完到重渲染之间读到的还是旧值）'
  );
  const warms = hookSource.match(/void warmRawDetails\(/g) ?? [];
  assert.ok(warms.length >= 2, '在线刷新与离线快照两条路都不能缺预热（刷新路优先用交回的那批）');
});

test('预热「没读到」时保留旧索引，且优先用快照交回的那批密文', () => {
  assert.match(
    hookSource,
    /rawDetailsOrgRef\.current !== ctx\.organizationId/,
    '读不到缓存时要把旧索引留着（那份密文还能用，判定仍靠 revisionDate）；只有换了组织才允许丢'
  );
  assert.match(
    hookSource,
    /if \(secrets\) rememberRawDetails\(nextContext, secrets\)/,
    '刷新路要直接拿快照函数交回的密文建索引，否则又要多读一遍 IndexedDB'
  );
});

test('两份缓存读出都只认自己组织的那一份', () => {
  for (const name of ['getOfflineSecretDetail', 'loadOfflineSecretDetails']) {
    assert.ok(
      apiSource.indexOf(`export async function ${name}(`) > 0,
      `没在 ${API} 里找到 ${name}（改名了就要更新这条护栏）`
    );
  }
  const guards = apiSource.match(/record\.organizationId !== ctx\.organizationId/g) ?? [];
  assert.equal(guards.length, 2, '两个读出都要卡组织：别家的密文不是这把密钥加密的，解出来是乱码');
});

test('判据能识破「先点亮加载态 / 先走网络」的负例', () => {
  assert.ok(orderIsCorrect(hookSource), '真源码本该合格');
  // 修复前就是这个形状：一进函数就点亮加载态，内存索引反而排在最后
  const negative = [
    'if (showSpinner) setSelectedSecretLoading(true);',
    'const local = await getOfflineSecretDetail(ctx, cacheKey, id);',
    'const details = await getSecretsByIds(fetcherRef.current, ctx, [id]);',
    'const raw = rawDetailsRef.current.get(id);',
  ].join('\n');
  assert.equal(orderIsCorrect(negative), false, '负例本该被拦下 —— 拦不下说明判据失效');
});

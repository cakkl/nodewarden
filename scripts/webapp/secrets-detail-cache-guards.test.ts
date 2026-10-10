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
    written: source.indexOf('writtenDetailsRef.current.get('),
    memory: source.indexOf('rawDetailsRef.current.get(id)'),
    snapshot: source.indexOf('await getOfflineSecretDetail('),
    loading: source.indexOf('setSelectedSecretLoading(true)'),
    network: source.indexOf('await getSecretsByIds('),
  };
}

const hookSource = readSource(HOOK);
const apiSource = readSource(API);
const at = positions(hookSource);

/** 四级齐备、顺序正确、且加载态落在网络那一支里。缺任何一项都算不合格。 */
function orderIsCorrect(source: string): boolean {
  const p = positions(source);
  return (
    p.written > 0 &&
    p.memory > 0 &&
    p.snapshot > 0 &&
    p.loading > 0 &&
    p.network > 0 &&
    p.written < p.memory &&
    p.memory < p.snapshot &&
    p.snapshot < p.loading &&
    p.loading < p.network
  );
}

test('loadDetail 四级顺序：刚写的 → 内存索引 → 本地快照 → 网络', () => {
  assert.ok(at.written > 0, `没在 ${HOOK} 里找到「刚写过那一条」的读取`);
  assert.ok(at.memory > 0, `没在 ${HOOK} 里找到内存索引的读取（改名了就要更新这条护栏）`);
  assert.ok(at.snapshot > 0, `没在 ${HOOK} 里找到本地快照的读取`);
  assert.ok(at.network > 0, `没在 ${HOOK} 里找到 getSecretsByIds 的调用`);
  assert.ok(at.written < at.memory, '刚写过的那条要排在内存索引前（它的密文要下次刷新才回吐）');
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

test('重拉与就地补丁两条路都要维护 revision 表，且索引在快照之后预热', () => {
  const reloadWrites = hookSource.match(/setLiveSecrets\(listed\.secrets\)/g) ?? [];
  const remembers = hookSource.match(/rememberRevisions\(listed\.secrets\)/g) ?? [];
  assert.ok(reloadWrites.length > 0, '没找到整页重拉写列表的地方');
  assert.equal(
    remembers.length,
    reloadWrites.length,
    '每个重拉写列表的地方都要同步记住 revisionDate（`liveSecrets` 是 state，' +
      'set 完到重渲染之间读到的还是旧值）'
  );
  // 就地补丁那条路：写入 / 删除都会让某些条目的 `revisionDate` 变（或消失），
  // 不同步这张表，详情就会拿旧值去比对，直接退化成走网络。
  const patched = hookSource.match(/revisionsRef\.current = /g) ?? [];
  assert.ok(patched.length >= 3, '就地补丁（新增 / 更新 / 删除）也必须维护 revision 表');
  const warms = hookSource.match(/void warmRawDetails\(/g) ?? [];
  assert.ok(warms.length >= 2, '在线刷新与离线快照两条路都不能缺预热（刷新路优先用交回的那批）');
});

test('六个写动作都就地打补丁（列表不必等整页刷新）', () => {
  assert.match(
    hookSource,
    /applySecretWrite\(created\)/,
    '新增成功后要先把响应补进列表，否则又要等到校准刷新回来才看得到'
  );
  assert.match(hookSource, /applySecretWrite\(await updateSecret\(/, '更新成功后同样就地补进列表');
  assert.match(hookSource, /removeSecretsLocally\(\[id\]\)/, '单条删除后要就地从列表拿掉');
  assert.match(hookSource, /removeSecretsLocally\(ids\)/, '批量删除同理');
  assert.match(hookSource, /applySecretProjectsLocally\(assignments\)/, '批量调项目后就地改 projectIds');
  assert.match(hookSource, /applyTagLocally\(created\.id, tag\)/, '新增后的标签也要写进本地映射（否则分组等下次刷新才变）');
});

test('写后校准走轻量路径：组织上下文复用缓存、不重拉标签与回收站', () => {
  assert.match(
    hookSource,
    /const calibrate = useCallback\(\(\) => refresh\(\{ skipTags: true, skipTrash: true \}\)/,
    '写动作的校准要跳过「标签」与「回收站」两次请求（标签由就地补丁维护，回收站的离线副本晚一步更新）'
  );
  assert.match(hookSource, /reload: calibrate \}\)/, '写动作默认走轻量校准');
  assert.match(hookSource, /reload: refresh \}\)/, '会改变「按标签分组」的动作（恢复回收站条目）仍走完整刷新');
  assert.match(hookSource, /\{ withTags: true \}\)/, '恢复回收站条目要带标签一起校准');
  assert.match(hookSource, /const nextContext = await resolveSecretsContext\(fetcherRef\.current, current\)/, '刷新要经共享的组织上下文缓存取上下文');
  assert.equal(
    (hookSource.match(/await ensureSecretsContext\(/g) ?? []).length,
    0,
    '机密 hook 不再直调 `ensureSecretsContext`（那 2 个请求每次刷新都白花）'
  );
  assert.equal(
    (readSource('webapp/src/hooks/useMachineAccounts.ts').match(/await ensureSecretsContext\(/g) ?? []).length,
    0,
    '机器账号 hook 同样要用共享缓存（否则首次加载 / 手动刷新又各花 2 个请求）'
  );
});

test('组织上下文缓存按会话键命中、并发只解析一次，且非解锁态会清掉（解密后的组织密钥不留在模块作用域）', () => {
  assert.match(apiSource, /let secretsContextCache: \{ key: string; task: Promise<SecretsContext> \} \| null = null/, '缓存放在 API 层 ⇒ 两个 hook 共用一份');
  assert.match(apiSource, /if \(cached\?\.key === key\) return cached\.task/, '按「令牌 + 用户密钥」命中：换会话自动失效');
  assert.match(apiSource, /const task = ensureSecretsContext\(authedFetch, session\);/, '先存 Promise 再 await ⇒ 并发的第二方拿到同一份在飞请求');
  assert.match(apiSource, /task\.catch\(\(\) => \{[\s\S]{0,120}secretsContextCache = null;/, '失败不缓存：一次网络抖动不该钉死整个会话');
  assert.match(apiSource, /export function clearSecretsContextCache\(\): void \{\s*secretsContextCache = null;/, '要提供清理入口');
  const appSource = readSource('webapp/src/App.tsx');
  assert.match(appSource, /if \(phase !== 'app'\) \{[\s\S]{0,200}clearSecretsContextCache\(\);/, '锁屏 / 退出（非 app 阶段）要清掉缓存的组织密钥');
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

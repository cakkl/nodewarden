// 启动期请求的护栏（2026-09-30）。三条都破了不报错，只是静默多打请求 / 多烧 Worker 调用。
// 实测背景（真实浏览器读 resource timing）：
// - `/api/accounts/profile` 每次解锁 **2** 次（回填请求与 profileQuery 同时飞出）；
// - `/api/devices/authorized` 每次启动 **2** 次（socket `open` 无条件刷）；
// - `/api/web-bootstrap?statusProbe=…` 原为每 **30 秒**一次。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 从 `start` 起截一段（把断言限制在某个函数 / 处理器内部）。 */
function slice(source: string, start: string, length: number): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `源码里找不到锚点 ${start} —— 写法变了，本护栏要跟着改`);
  return source.slice(at, at + length);
}

test('解锁回填期间不发 profileQuery，回填结果写进同一个 key', () => {
  const app = readSource('webapp/src/App.tsx');
  // ⚠️ 只「回填后 seed 缓存」不够：profileQuery 在 phase='app' 那一刻就发请求了，
  // seed 永远晚于那次重复请求（踩过）。必须在回填落地前把查询关着。
  const profileQuery = slice(app, 'const profileQuery = useQuery({', 400);
  assert.match(
    profileQuery,
    /enabled: [^\n]*&& !profileHydrationPending/,
    'profileQuery 要靠 profileHydrationPending 门控'
  );
  assert.match(app, /const \[profileHydrationPending, setProfileHydrationPending\] = useState\(false\);/);

  const finalize = slice(app, 'async function finalizeLogin', 2000);
  assert.match(finalize, /setProfileHydrationPending\(true\);/, '解锁开始就要置为「回填中」');
  assert.match(
    finalize,
    /queryClient\.setQueryData\(profileCacheKey\(hydratedProfile\.id, login\.session\.email\), hydratedProfile\)/,
    '拿到的 profile 要写进缓存，不然 profileQuery 会再拉一份同样的 ~5 KB'
  );
  // 必须写在 finally 里：失败或会话切换（提前 return）都不能把 profileQuery 永久关掉
  assert.match(
    finalize,
    /\} finally \{[\s\S]{0,120}?setProfileHydrationPending\(false\);/,
    '放行必须走 finally，提前 return 也要覆盖'
  );

  // key 两边共用同一个函数，否则迟早漂
  assert.match(app, /queryKey: profileCacheKey\(profile\?\.id, session\?\.email\)/, 'profileQuery 要用共享的 key 函数');
  assert.doesNotMatch(app, /queryKey: \['profile',/, '不得再手写 profile 的 key（写错就白做，且不报错）');
});

test('SignalR 只在重连时刷新设备列表', () => {
  const app = readSource('webapp/src/App.tsx');
  const openHandler = slice(app, "socket.addEventListener('open'", 900);
  assert.match(
    openHandler,
    /if \(connectedOnce\) \{\s*void refreshAuthorizedDevicesRef\.current\(\);\s*\}\s*connectedOnce = true;/,
    '首次连接紧跟在启动查询之后（实测相隔 262 ms，查询还在飞行中）⇒ 刷新纯属重复'
  );
  // 标志位用 effect 内的局部变量：换会话时 effect 重建，计数自然归零
  const effect = slice(app, 'let connectedOnce = false;', 120);
  assert.equal(effect.match(/let connectedOnce = false;/g)?.length, 1);
  assert.doesNotMatch(app, /connectedOnceRef/, '不得用组件级 ref 跨会话保留这个计数');
  assert.doesNotMatch(openHandler, /queryClient\.getQueryCache\(\)/, '别用时间戳判过期：首次查询其实还在飞行中');
});

test('管理员数据只在对应页面才拉，不在启动时白跑', () => {
  const app = readSource('webapp/src/App.tsx');
  // 都只被懒加载的页面组件消费 ⇒ 启动时（用户还在密码库）拉它们纯属浪费：
  // 每个请求都是一次 Worker 调用 + 若干 D1 往返。实测启动期因此少 4 个请求。
  const gated = [
    ['admin-users', 'onAdminRoute'],
    ['admin-invites', 'onAdminRoute'],
    ['admin-backup-settings', 'location.startsWith(ROUTES.backup)'],
    ['admin-mail-settings', 'location.startsWith(ROUTES.settings)'],
  ];
  for (const [key, gate] of gated) {
    const block = slice(app, `queryKey: ['${key}',`, 400);
    const enabled = block.match(/enabled:[^\n]*/);
    assert.ok(enabled, `${key} 应有 enabled 条件`);
    assert.ok(
      enabled[0].includes(gate),
      `${key} 要按「${gate}」门控 —— 否则每次启动都会替管理员多打一个请求`
    );
  }
  assert.match(app, /const onAdminRoute = location === ROUTES\.admin;/, '要有明确的管理页判定');

  // ⚠️ 静默修复**不能**门控：它修的是历史加密格式的备份设置，
  // 若用户长期不进备份页就永远不修，而定时备份照跑。
  const repair = slice(app, 'repairAttemptRef.current = session.accessToken;', 200);
  assert.match(repair, /silentlyRepairBackupSettingsIfNeeded/, '登录后仍要执行一次备份设置修复');
});

test('服务可达性心跳是 5 分钟兜底，且后台标签不探', () => {
  const badge = readSource('webapp/src/components/NetworkStatusBadge.tsx');
  const intervalMatch = badge.match(/STATUS_CHECK_INTERVAL_MS = (\d+)\s*\*\s*60_000;/);
  assert.ok(intervalMatch, '间隔要写成 `<分钟> * 60_000`，便于这里断言');
  assert.ok(
    Number(intervalMatch[1]) >= 5,
    `周期兜底不得低于 5 分钟（当前 ${intervalMatch[1]}）—— 每次都是一次完整 Worker 调用`
  );

  const schedule = slice(badge, 'const scheduleNextCheck', 500);
  assert.match(
    schedule,
    /document\.visibilityState === 'visible' \? checkService\(\)/,
    '后台标签不探：浏览器会把定时器节流到约 1 次/分钟，白烧 Worker 调用'
  );
  // 重新可见 / 恢复焦点 / 回到在线，这三条路径仍要立刻补探
  const visibilityHandler = slice(badge, 'const handleVisibilityChange', 200);
  assert.match(visibilityHandler, /document\.visibilityState === 'visible'\) void checkService\(\)/);
  assert.match(badge, /window\.addEventListener\('online', handleOnline\)/);
  assert.match(badge, /window\.addEventListener\('focus', handleOnline\)/);
});

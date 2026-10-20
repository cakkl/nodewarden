// 写操作的重入保护（按类型门闩 + 按钮置灰）。
//
// 现象（2026-10-20 实测）：网络卡顿时在「新建项目」里连点两次 ✓，服务端真的建出两个同名项目。
// 根因：提交函数没有在途状态、`disabled` 只判名字是否为空，而服务端创建项目不带幂等键
// （官方 API 同形）⇒ 两次 POST 就是两条记录。机密保存、项目重命名、机器账号及令牌同理。
//
// 门闩机制的解释在 `single-flight.ts`，这里只钉接线：同类必须互斥、异类必须放行。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createSingleFlight, createSingleFlightRegistry } from '../../webapp/src/lib/single-flight';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 去掉注释 —— 否则注释里写过的守卫语句也算命中。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const hook = stripComments(readSource('webapp/src/hooks/useSecretsManager.ts'));
const page = stripComments(readSource('webapp/src/components/SecretsPage.tsx'));
const machinePage = stripComments(readSource('webapp/src/components/MachineAccountsPage.tsx'));

test('单飞门闩：在途时第二次调用被丢弃，任务体只执行一次', async () => {
  const gate = createSingleFlight();
  let release!: (value: string) => void;
  let calls = 0;

  const first = gate.run(() => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  assert.equal(gate.active, true, '任务进行中应该能被同步看到');

  const second = await gate.run(async () => {
    calls += 1;
    return 'second';
  });
  assert.equal(second, null, '第二次调用必须被丢弃（返回 null）');

  release('first');
  assert.equal(await first, 'first');
  assert.equal(calls, 1, '任务体只能执行一次 —— 否则就是「双击建出两条」');
  assert.equal(gate.active, false, '结束后必须复位');
});

test('单飞门闩：任务抛错也复位，且错误照常抛出', async () => {
  const gate = createSingleFlight();
  await assert.rejects(
    () =>
      gate.run(async () => {
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(gate.active, false, '失败后必须复位，否则之后的写操作会被永久拦掉');
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('单飞门闩：tryEnter 同步占位，release 之后才能再拿到', () => {
  const gate = createSingleFlight();
  assert.equal(gate.tryEnter(), true, '首次占位应成功');
  assert.equal(gate.tryEnter(), false, '在途时第二次占位必须失败（这就是双击的第二下）');
  assert.equal(gate.active, true);
  gate.release();
  assert.equal(gate.active, false);
  assert.equal(gate.tryEnter(), true, 'release 之后应能重新拿到');
});

test('runAction 按操作类型加门闩（同类丢弃，异类并行）', () => {
  assert.match(
    hook,
    /const writeGates = useRef\(createSingleFlightRegistry<WriteKind>\(\)\)\.current;/,
    '需要按类型分配的门闩注册表'
  );
  const gateAt = hook.indexOf("await writeGates.gate(kind).run(");
  assert.notEqual(gateAt, -1, 'runAction 必须用对应类型的门闩包住写操作');

  const callAt = hook.indexOf('(options?.withTags ? runWithTags : run)');
  assert.ok(callAt > gateAt, '门闩必须包在 run / runWithTags 外面（否则拦不住请求）');

  // 每个写操作都要标类型：漏一个就等于那一个没有防双击
  const kinds = hook.match(/runAction\('(?:project|secret|trash)'/g) ?? [];
  assert.equal(kinds.length, 10, '10 个写操作都应显式传入操作类型');
  assert.match(hook, /type WriteKind = 'project' \| 'secret' \| 'trash';/, '类型定义变了：请同步本护栏');
});

test('写操作进行中对外暴露 busy（计数制，多个类型并行时不会提前恢复）', () => {
  assert.match(hook, /busy:\s*boolean;/, 'SecretsManagerProps 必须声明 busy');
  assert.match(hook, /const \[pendingWrites, setPendingWrites\] = useState\(0\);/, 'busy 要用计数而非布尔');
  assert.match(hook, /const busy = pendingWrites > 0;/, '对外暴露的 busy 由计数算出');
  assert.match(hook, /^\s*ready,\n\s*busy,/m, 'useSecretsManager 的返回值里要带上 busy');
});

test('门闩注册表：同 key 互斥、异 key 并行', async () => {
  const registry = createSingleFlightRegistry<'project' | 'secret' | 'trash'>();
  const projectGate = registry.gate('project');

  assert.equal(projectGate.tryEnter(), true, '首个 project 写操作应该拿到门');
  assert.equal(registry.gate('project').tryEnter(), false, '同类型第二次必须被拦（双击）');
  assert.equal(
    registry.gate('secret').tryEnter(),
    true,
    '不同类型必须能并行 —— 否则「保存机密」会把「删除项目」误伤成无反应'
  );

  projectGate.release();
  assert.equal(projectGate.tryEnter(), true, '释放后应能重新拿到');
  assert.equal(registry.gate('project'), projectGate, '同一个 key 必须复用同一个门');
});

/** 取某个调用点之前一小段文本，用来断言同一个按钮块里的 `disabled`。 */
function windowBefore(source: string, needle: string, size: number): string {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `找不到 ${needle}（改名了请同步本护栏）`);
  return source.slice(Math.max(0, at - size), at);
}

test('三个表单提交按钮都在 busy 时置灰', () => {
  assert.ok(
    page.includes('disabled={busy || !newProjectName.trim()}'),
    '「新建项目」的 ✓ 必须带 busy（原先只判了名字非空 ⇒ 双击连发两次）'
  );
  assert.ok(
    page.includes('disabled={busy || !manager.ready || !draft.input.key.trim()}'),
    '机密「确认」保存必须带 busy'
  );
  assert.match(
    windowBefore(page, 'onClick={() => void submitRenameProject()}', 400),
    /disabled=\{busy\}/,
    '「重命名项目」的 ✓ 必须带 busy'
  );
});

test('机器账号页：建账号 / 建令牌各用一道门，且释放写在 finally 里', () => {
  assert.match(
    machinePage,
    /createSingleFlightRegistry<'account' \| 'token'>\(\)/,
    '账号与令牌要用不同 key 的门闩（保存账号时仍可建令牌）'
  );

  const entered = machinePage.match(/if \(!writeGates\.gate\('(account|token)'\)\.tryEnter\(\)\) return;/g) ?? [];
  assert.equal(entered.length, 2, 'saveDraft 与 submitToken 两处都要占位（少一处就能双击建两个）');

  const released = machinePage.match(/writeGates\.gate\('(account|token)'\)\.release\(\);/g) ?? [];
  assert.equal(released.length, 2, '两处 finally 都要 release，否则后续写操作会被永久拦掉');
});

// 确认弹窗的时序护栏：不许回到「先关弹窗、再等结果」。
//
// 破了不报错：高延迟下用户点完确认，弹窗立刻消失、几秒后才弹 toast —— 看起来像「点了没反应」，
// 还会让人重复点击（这是用户在删除设备时实际反馈过的问题）。
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

/** 两个 hook 里的确认动作都改成「await 完、成功才关」，含 13 处账号安全 / 管理员操作 */
const CONFIRM_ACTION_FILES = [
  'webapp/src/hooks/useAccountSecurityActions.ts',
  'webapp/src/hooks/useAdminActions.ts',
];

test('确认动作不得「先关弹窗、再起异步」', () => {
  for (const file of CONFIRM_ACTION_FILES) {
    const offenders = [...readSource(file).matchAll(/onSetConfirm\(null\);\s*\n\s*void \(async/g)].length;
    assert.equal(
      offenders,
      0,
      `${file} 里仍有 ${offenders} 处「先 onSetConfirm(null) 再起异步」—— 弹窗会在结果返回前就消失`
    );
  }
});

test('ConfirmDialog 会等异步确认动作：期间禁用按钮并显示进度', () => {
  const source = readSource('webapp/src/components/ConfirmDialog.tsx');
  assert.match(source, /onConfirm: \(\) => void \| Promise<void>/, 'onConfirm 必须允许返回 Promise');
  assert.match(source, /await props\.onConfirm\(\)/, '必须 await 确认动作，否则 busy 立刻复位');
  assert.match(source, /disabled=\{props\.confirmDisabled \|\| busy\}/, '处理中必须禁用确认按钮（防重复点击）');
  assert.match(source, /disabled=\{props\.cancelDisabled \|\| busy\}/, '处理中必须禁用取消按钮');
  assert.match(source, /busy \? t\('txt_loading'\)/, '处理中要有可见反馈');
});

test('容器把 Promise 传下去（不 return 的话弹窗立刻就复位了）', () => {
  const source = readSource('webapp/src/components/AppGlobalOverlays.tsx');
  assert.match(source, /return props\.confirm\?\.onConfirm\(/, 'onConfirm 包装必须 return Promise');
  assert.match(
    source,
    /if \(!props\.confirm\) setConfirmPassword\(''\)/,
    '主密码要在确认框关闭时清空（提交时不清，失败才能直接重试）'
  );
});

// 恢复**失败**时的提示护栏（PERF 62 的第 2 件）。
//
// 破了的后果都是「界面在说与事实相反的话」：复用「正在校验并完成切换」的进行中文案、
// 面板 1.2 秒后自动关闭、计时继续涨、且不说明「原有数据未作改动」（那正是影子表交换换来的保证）。
//
// 运行方式：npm run test:backup-restore-failure
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** 从 `start` 起截一段（把断言限制在某个分支内部）。 */
function slice(source: string, start: string, length: number): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `源码里找不到锚点 ${start} —— 写法变了，本护栏要跟着改`);
  return source.slice(at, at + length);
}

const DETAIL_KEYS = [
  'txt_backup_restore_progress_local_failed_detail',
  'txt_backup_restore_progress_remote_failed_detail',
];

// 标题复用既有的「备份还原失败 / 还原远端备份失败」⇒ 不新增标题键（少一处翻译面）
const TITLE_KEYS = ['txt_backup_restore_failed', 'txt_backup_remote_restore_failed'];

test('失败上报必须用专门的失败文案，不得复用「正在进行」的那条', () => {
  const server = readSource('src/services/backup-import.ts');
  for (const [step, titleKey, detailKey] of [
    ['local_failed', TITLE_KEYS[0], DETAIL_KEYS[0]],
    ['remote_failed', TITLE_KEYS[1], DETAIL_KEYS[1]],
  ]) {
    const branch = slice(server, `step: '${step}'`, 420);
    assert.match(branch, new RegExp(`stageTitle: '${titleKey}'`), `${step} 的标题应复用既有的失败文案`);
    assert.match(branch, new RegExp(`stageDetail: '${detailKey}'`), `${step} 应使用专门的失败说明`);
    assert.doesNotMatch(
      branch,
      /_finalize_title|_finalize_detail/,
      `${step} 不得复用「正在校验并完成切换」—— 那一刻已经失败了`
    );
  }
});

test('失败说明必须让用户知道「原有数据未作改动」', () => {
  for (const key of DETAIL_KEYS) {
    for (const locale of ['en', 'zh-CN']) {
      assert.match(readSource(`webapp/src/lib/i18n/locales/${locale}.ts`), new RegExp(`"${key}": "[^"]+"`), `${locale} 缺 ${key}`);
    }
  }
  // 语义断言放在英文（参考语言）上：说明数据未作改动 + 给出重试指引
  const en = readSource('webapp/src/lib/i18n/locales/en.ts');
  const detail = en.match(/"txt_backup_restore_progress_local_failed_detail": "([^"]+)"/)?.[1] || '';
  assert.match(detail, /not modified/i, `失败说明要点明「原有数据未作改动」，实际：${detail}`);
  assert.match(detail, /try again/i, `失败说明要给出重试指引，实际：${detail}`);
});

test('失败时进度面板不得自动关闭，且必须能手动关闭；计时必须冻结', () => {
  const page = readSource('webapp/src/components/BackupCenterPage.tsx');
  // 自动关闭只在成功时发生
  assert.match(
    page,
    /if \(detail\.done && !failed\) \{/,
    '失败必须不自动关闭 —— 否则用户来不及看清「数据未作改动」，面板 1.2 秒后就没了'
  );
  // 失败态要有可见的失败样式 + 关闭入口
  const failedBlock = slice(page, 'restoreProgress.failed && (', 420);
  assert.match(failedBlock, /txt_close/, '失败面板必须有「关闭」按钮（否则用户被模态挡住没法操作）');
  assert.match(page, /restore-progress-current\$\{restoreProgress\.failed \? ' failed' : ''\}/, '当前块要有失败样式');
  assert.match(page, /'failed'/, '步骤列表要有 failed 状态');
  // 失败态样式得真的存在于样式表里
  const css = readSource('webapp/src/styles/management.css');
  assert.match(css, /\.restore-progress-current\.failed\s*\{/, '缺少当前块的失败样式');
  assert.match(css, /\.restore-progress-item\.failed/, '缺少步骤项的失败样式');

  // 计时器：失败后必须冻结 —— 否则秒数继续涨，等于在说「还在跑」
  const timer = slice(page, 'setRestoreElapsedSeconds(Math.max(0, Math.floor((Date.now() - restoreProgress.startedAt) / 1000)));', 500);
  assert.match(
    timer,
    /if \(restoreProgress\.failed\) return;/,
    '失败后不得再起 setInterval —— 面板会停在那里等用户读，秒数继续走会误导'
  );
});

test('失败时保留已走过的进度，不回退到第 0 步', () => {
  const page = readSource('webapp/src/components/BackupCenterPage.tsx');
  const handler = slice(page, 'const failed = detail.ok === false;', 900);
  assert.match(
    handler,
    /carriedPhaseIndex/,
    '失败记录的 stageTitle 不属于任何阶段 ⇒ 必须沿用上一轮的 phaseIndex，否则步骤列表会跳回开头'
  );
  assert.match(handler, /Math\.min\(carriedPhaseIndex, Math\.max\(0, phases\.length - 1\)\)/, 'phaseIndex 要限制在合法范围');
});

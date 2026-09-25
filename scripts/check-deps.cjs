const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// CONTRACT:
// 提交前跑：① 每个依赖是否已是最新发布版；② `allowScripts` 是否仍与实际安装版本一致。
// 用法：npm run deps:check   （`--offline` 只做第 ② 项，不访问 registry）

const root = path.join(__dirname, '..');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (error) {
  console.error(`❌ package.json 无法解析（${error.message}）⇒ 先修好它再提交`);
  process.exit(1);
}
const offline = process.argv.includes('--offline');
const problems = [];
// 只有真拿到 registry 数据时才能声称「没有落后」；离线或查询失败都当作「未比对」。
let comparedLatest = false;

// ① 白名单与实际安装版本。升级依赖**不会**自动同步 allowScripts，而 npm 会拦下
// 未覆盖的 install script ⇒ 新版本的 postinstall 被静默跳过（workerd 就会因此起不来）。
for (const key of Object.keys(pkg.allowScripts || {})) {
  const at = key.lastIndexOf('@');
  const name = key.slice(0, at);
  const expected = key.slice(at + 1);
  const installed = path.join(root, 'node_modules', name, 'package.json');
  if (!fs.existsSync(installed)) {
    problems.push(`${name}：allowScripts 里有 "${key}"，但 node_modules 里没有它（先跑 npm install）`);
    continue;
  }
  const actual = JSON.parse(fs.readFileSync(installed, 'utf8')).version;
  if (actual !== expected) {
    problems.push(`${name}：allowScripts 写的是 ${expected}，实际装的是 ${actual} ⇒ 改为 "${name}@${actual}": true`);
  }
}

// ② 是否落后于最新版
if (!offline) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let raw = '';
  try {
    raw = execFileSync(npm, ['outdated', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // 有落后依赖时 npm outdated 退出码为 1，但 stdout 仍是完整 JSON
    raw = String(error.stdout || '');
    if (!raw.trim()) {
      console.warn('⚠️  拿不到 npm outdated 的输出（离线或 registry 不可达）⇒ 本次只检查了 allowScripts');
    }
  }
  if (raw.trim()) {
    comparedLatest = true;
    for (const [name, info] of Object.entries(JSON.parse(raw))) {
      const scope = info.type === 'devDependencies' ? 'dev ' : '';
      problems.push(`${name}（${scope}当前 ${info.current} → 最新 ${info.latest}）`);
    }
  }
}

if (problems.length === 0) {
  console.log(
    comparedLatest
      ? '✅ 依赖检查通过：allowScripts 与实际安装版本一致，且没有落后于最新版的依赖'
      : `✅ 依赖检查通过：allowScripts 与实际安装版本一致（${offline ? '--offline' : 'registry 不可达'}：未比对最新版）`
  );
  process.exit(0);
}

console.error('❌ 依赖检查未通过：\n');
for (const problem of problems) console.error(`  · ${problem}`);
console.error('\n升级：ncu -u && npm install');
console.error('若 npm 提示 install script 被拦（allowScripts 未覆盖），用 npm install-scripts approve <包名> 更新白名单。');
console.error('升级后必须跑 npm run verify —— 依赖里被移除的 API 只有 typecheck / build 能发现。');
process.exit(1);

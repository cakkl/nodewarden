// 两步登录设置页 / 登录弹窗的契约护栏（源码文本抽取，无 DOM 依赖）：
// ① 每行提供程序都有「默认」按钮（未启用与已选中禁用）；
// ② 恢复码只能是「其他验证方式」里的**最后**一项，且切过去后能切回原方式、
//    不能有会跳走页面的独立入口（点一下离开界面，刚发出的邮件码就白烧一格配额）；
// ③ 客户端不得重排服务端给的提供程序顺序 —— 那会静默抹平「默认方式」；
// ④ 弹窗内的重发按钮受倒计时驱动（未启用的行/已选中的行都不该出现可点的假按钮）。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('设置页：四种提供程序各自都有「默认」按钮，且只由 defaultProviderButton 渲染', () => {
  const source = readSource('webapp/src/components/SettingsPage.tsx');
  const calls = source.match(/defaultProviderButton\(/g) || [];
  // 一处是函数定义，其余四处是四行提供程序
  assert.equal(calls.length, 5, `期望 1 处定义 + 4 处调用，实际 ${calls.length} —— 新增/删除提供程序行时请同步本护栏`);
  for (const provider of ['TWO_FACTOR_PROVIDER_EMAIL', 'TWO_FACTOR_PROVIDER_AUTHENTICATOR', 'TWO_FACTOR_PROVIDER_WEBAUTHN', 'TWO_FACTOR_PROVIDER_YUBIKEY']) {
    assert.match(
      source,
      new RegExp(`defaultProviderButton\\(${provider},`),
      `${provider} 那一行缺少「默认」按钮`
    );
  }
  // 禁用条件必须同时覆盖「未启用」与「已是默认」，否则会出现点不动的假按钮或重复提交
  const button = source.slice(source.indexOf('function defaultProviderButton('), source.indexOf('function defaultProviderButton(') + 500);
  assert.match(button, /disabled=\{[^}]*!enabled[^}]*\}/, '未启用的行必须禁用「默认」按钮');
  assert.match(button, /disabled=\{[^}]*isDefault[^}]*\}/, '已是默认的行必须禁用「默认」按钮');
});

test('登录弹窗：恢复码排在「其他验证方式」最后，且不再有会跳走页面的独立入口', () => {
  const overlays = readSource('webapp/src/components/AppGlobalOverlays.tsx');
  assert.match(
    overlays,
    /methodOptions = \[\.\.\.switchableProviders, TWO_FACTOR_PROVIDER_RECOVERY_CODE\]/,
    '恢复码必须是列表最后一项（顺序/变量名变了请同步本护栏）'
  );
  assert.match(overlays, /methodOptions\.map\(/, '切换列表要渲染 methodOptions（含恢复码）');
  assert.doesNotMatch(overlays, /onUseRecoveryCode/, '弹窗里不能再有独立的「使用恢复代码」入口');
  // 切换入口不能带任何条件：只剩一种常规方式时也必须能打开，否则恢复码根本进不去
  const switcherIndex = overlays.indexOf('<div className="two-factor-method-switcher">');
  assert.notEqual(switcherIndex, -1, '找不到切换列表的容器：结构变了请同步本护栏');
  assert.doesNotMatch(
    overlays.slice(Math.max(0, switcherIndex - 200), switcherIndex),
    /&&/,
    '切换入口不能挂在条件后面（会挡住恢复码）'
  );

  const routes = readSource('webapp/src/lib/routes.ts');
  assert.doesNotMatch(routes, /recover-2fa/, '独立恢复页已删除：路由不能复活（否则又会出现「点一下就跳走」的入口）');
});

test('登录弹窗：使用恢复码前必须有红字警告与二次确认', () => {
  const overlays = readSource('webapp/src/components/AppGlobalOverlays.tsx');
  assert.match(overlays, /txt_recovery_code_disables_all_two_step_warning/, '切换后要显示「会停用全部两步登录」的红字警告');
  assert.match(overlays, /txt_recovery_code_disable_confirm_message/, '提交前要弹二次确认');
  assert.match(overlays, /props\.onSubmitRecoveryCode\(/, '恢复码必须就地提交（不跳页）');
});

test('登录弹窗：切到恢复码后必须还能切回原来的验证方式', () => {
  const overlays = readSource('webapp/src/components/AppGlobalOverlays.tsx');
  // 普通模式下列表里排除「当前方式」（它已经在用了），但恢复码模式下必须把它列回来 ——
  // 否则账号只开了一种方式时，列表里就只剩「恢复代码」，用户被卡在恢复码界面出不来。
  assert.match(
    overlays,
    /recoveryMode \|\| provider !== props\.pendingTotpProviderType/,
    '恢复码模式下要把当前提供程序也列进「其他验证方式」'
  );
  // 唯一该置灰的是「已经选中的恢复码」本身，提供程序项必须始终可点
  assert.match(
    overlays,
    /isActiveOption = providerType === TWO_FACTOR_PROVIDER_RECOVERY_CODE && recoveryMode/,
    '列表里只应把「已选中的恢复码」置灰'
  );
});

test('客户端必须保留服务端给的提供程序顺序（否则「默认方式」被静默抹平）', () => {
  const source = readSource('webapp/src/lib/app-auth.ts');
  // 服务端把用户选定的默认方式排在首位；客户端一旦按固定顺序重排，默认方式就永远失效，
  // 而且没有任何报错 —— 这也是官方客户端选择默认方式的方式（读列表第一项）。
  assert.doesNotMatch(
    source,
    /SUPPORTED_TWO_FACTOR_PROVIDERS\.filter\(/,
    '不能按固定顺序重排服务端给的列表（只允许过滤 + 去重）'
  );
  assert.match(source, /function normalizeTwoFactorProviders\(/, '名字变了请同步本护栏');
  // 解析「默认哪个」的入口必须取首位
  assert.match(source, /function resolvePendingTwoFactorProvider\([\s\S]{0,120}\[0\]/, '初始选中的方式必须取服务端列表的首位');
});

test('邮件 2FA：默认方式不是邮件时，切到邮件要自动补发一枚；已经发过则不重发', () => {
  const source = readSource('webapp/src/App.tsx');
  // 两条都踩过：① 切过来没有码（用户不知道去哪拿）；② 每次切回都重发（撞 60 秒冷却，
  // 还会让用户刚收到的那枚立刻失效，因为每用户同时只有一枚待用码）。
  assert.match(
    source,
    /providerType === TWO_FACTOR_PROVIDER_EMAIL && pendingTotp && !emailCodeSentRef\.current/,
    '切换补发必须以「本轮挑战还没发过码」为条件'
  );
  assert.match(source, /emailCodeSentRef\.current = true;/, '发过码（含尝试失败）后要记下来，避免每次切换都自动重试');
  assert.match(source, /function beginTotpChallenge\(/, '进入挑战时要重置「本轮是否已发过码」');
  assert.match(source, /if \(pending\.providerType === TWO_FACTOR_PROVIDER_EMAIL\)/, '默认方式就是邮件时进入挑战要立刻发码');
});

test('登录弹窗内的重发按钮：按倒计时禁用并显示剩余秒数', () => {
  const overlays = readSource('webapp/src/components/AppGlobalOverlays.tsx');
  const blocks = overlays
    .split('<button')
    .slice(1)
    .map((chunk) => chunk.slice(0, 1500))
    .filter((chunk) => chunk.includes("t('txt_resend_code')"));
  assert.equal(blocks.length, 2, `期望邮件 2FA 与新设备验证各一个重发按钮，实际 ${blocks.length}`);
  for (const block of blocks) {
    assert.match(block, /disabled=\{[^}]*[Rr]esendIn\b[^}]*\}/s, '重发按钮必须按倒计时禁用（冷却期内点了只会报错）');
    assert.match(block, /resendLabel\(/, '重发按钮文案必须用 resendLabel 拼出剩余秒数');
  }
});

test('恢复码登录：走「恢复码 = 2FA 提供程序」的单请求，且必须接住可能的新设备验证', () => {
  const auth = readSource('webapp/src/lib/app-auth.ts');
  // 服务端在同一个 password grant 里校验恢复码、停用全部 2FA 并签发 token。
  // ⛔ 曾经的写法是「先 /recover-2fa 再补一次 password grant」：那次请求时账号已无 2FA，
  // 而后置的新设备验证只在账号没有 2FA 时生效 ⇒ 用户拿到「恢复成功但自动登录失败」。
  assert.match(auth, /twoFactorProvider: TWO_FACTOR_PROVIDER_RECOVERY_CODE/, '恢复码必须作为提供程序（8）随登录请求发出');
  assert.doesNotMatch(auth, /recoverTwoFactor/, '客户端不能再「先调停用端点、再单独登录一次」');
  assert.doesNotMatch(readSource('webapp/src/lib/api/auth.ts'), /function recoverTwoFactor\b/, '旧包装函数不该复活');
  assert.match(auth, /kind: 'device-verification'/, '仍要处理新设备验证分支（服务端若改判定，界面不能只剩一句失败提示）');

  const app = readSource('webapp/src/App.tsx');
  assert.match(app, /recovered\.kind === 'device-verification'/, 'App 必须把该分支转交给新设备验证弹窗');
  assert.match(app, /setPendingDeviceVerification\(recovered\.pendingDeviceVerification\)/, '转交时要带上主密码材料，用户不必重新输入');
});

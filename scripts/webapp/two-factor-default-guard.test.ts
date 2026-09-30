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

test('恢复码警告文案：枚举顺序与提供程序规范顺序一致（邮件排第一）', () => {
  // 顺序即设置页列表的顺序（`TWO_FACTOR_PROVIDER_PREFERENCE_ORDER`）：邮件是默认首选，文案不该另排一套。
  const locales: Array<[string, string, string]> = [
    ['zh-CN', '邮件', '验证器'],
    ['zh-TW', '郵件', '驗證器'],
    ['en', 'email', 'authenticator'],
    ['de', 'E-Mail', 'Authenticator'],
    ['es', 'correo', 'autenticación'],
    ['fi', 'sähköposti', 'todennussovellus'],
    ['fr', 'e-mail', 'authentification'],
    ['it', 'e-mail', 'autenticazione'],
    ['ru', 'почта', 'аутентификатор'],
    ['sv', 'e-post', 'autentiseringsapp'],
  ];
  for (const [locale, emailWord, authenticatorWord] of locales) {
    const source = readSource(`webapp/src/lib/i18n/locales/${locale}.ts`);
    const match = source.match(/"txt_recovery_code_disables_all_two_step_warning":\s*"([^"]+)"/);
    assert.ok(match, `${locale}: 找不到恢复码警告文案（键名改了请同步本护栏）`);
    const text = match[1];
    const emailIndex = text.indexOf(emailWord);
    const authenticatorIndex = text.indexOf(authenticatorWord);
    assert.ok(emailIndex >= 0 && authenticatorIndex >= 0, `${locale}: 文案应同时列出邮件与验证器`);
    assert.ok(emailIndex < authenticatorIndex, `${locale}: 邮件必须排在验证器之前（顺序同设置页列表）`);
  }
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
  // 服务端在同一个 password grant 里校验恢复码、停用全部 2FA、轮换恢复码并签发 token。
  // ⛔ 曾经的写法是「先 /recover-2fa 再补一次 password grant」：那次请求时账号已无 2FA，
  // 而后置的新设备验证只在账号没有 2FA 时生效 ⇒ 用户拿到「恢复成功但自动登录失败」。
  assert.match(auth, /twoFactorProvider: TWO_FACTOR_PROVIDER_RECOVERY_CODE/, '恢复码必须作为提供程序（8）随登录请求发出');
  assert.doesNotMatch(auth, /recoverTwoFactor/, '客户端不能再「先停用恢复码端点、再单独登录一次」');
  assert.doesNotMatch(readSource('webapp/src/lib/api/auth.ts'), /function recoverTwoFactor\b/, '旧包装函数不该复活');
  assert.match(auth, /kind: 'device-verification'/, '仍要处理新设备验证分支（服务端若改判定，界面不能只剩一句失败提示）');

  const app = readSource('webapp/src/App.tsx');
  assert.match(app, /recovered\.kind === 'device-verification'/, 'App 必须把该分支转交给新设备验证弹窗');
  assert.match(app, /setPendingDeviceVerification\(recovered\.pendingDeviceVerification\)/, '转交时要带上主密码材料，用户不必重新输入');
});

test('恢复码提示：只提示去设置里查看，不在 toast 里显示新恢复码', () => {
  // 一次性凭据不进提示：toast 可能被旁座看到、也会一闪而过，用户需要它时应当主动去设置里取。
  const app = readSource('webapp/src/App.tsx');
  assert.match(app, /txt_text_2fa_recovered_check_recovery_code/, '恢复完成要提示到设置里查看新的恢复码');
  assert.doesNotMatch(app, /newRecoveryCode/, '提示里不能再出现恢复码本身');
  assert.doesNotMatch(
    readSource('webapp/src/lib/app-auth.ts'),
    /readRotatedRecoveryCode\(/,
    '既然不显示，就不必再为它多取一次恢复码'
  );

  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    const source = readSource(`webapp/src/lib/i18n/locales/${locale}.ts`);
    const match = source.match(/"txt_text_2fa_recovered_check_recovery_code":\s*"([^"]+)"/);
    assert.ok(match, `${locale}: 缺少恢复提示文案（键名改了请同步本护栏）`);
    assert.doesNotMatch(match[1], /\{/, `${locale}: 提示文案里不能带占位符 —— 那会变回「直接显示恢复码」`);
  }
});

// 服务端发不出信时，邮箱 2FA 既开不了也发不出码（登录也不再要求它）⇒ 整行不渲染。
test('设置页：发不出信时整行不渲染邮箱 2FA（不显示任何占位说明）', () => {
  const source = readSource('webapp/src/components/SettingsPage.tsx');
  assert.match(source, /\{!props\.mailDeliveryUnavailable && \(/, '邮箱行必须受「发不出信」控制');
  assert.match(
    source,
    /<div className="two-step-provider-row">\s*<div className="two-step-provider-icon">\s*<Mail size=\{28\} \/>/,
    '邮件行必须整体包在条件里（只藏按钮不算藏条目）'
  );
});

// 「刷新状态」按钮在提供程序模块的标题行 → 用户会期待它把邮件那一行也刷新。
// 邮件两步登录的状态走的是另一个端点（`get-email`），而邮件行是否渲染又是 `/api/config` 说了算，
// 只刷 `two-factor` 会让其中两者停在旧值（例如在另一个标签页开了邮件 2FA）。
test('设置页：「刷新状态」同时刷新提供程序、邮件两步登录与发信能力', () => {
  const source = readSource('webapp/src/components/SettingsPage.tsx');
  const start = source.indexOf('async function refreshTwoFactorStatus(');
  assert.notEqual(start, -1, '找不到刷新处理函数（改名了请同步本护栏）');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /props\.onRefreshTwoFactorStatus\(\)/, '缺少提供程序 / 默认方式刷新');
  assert.match(body, /refreshEmailTwoFactor\(\)/, '缺少邮件两步登录状态刷新（它走的是另一个端点）');
  assert.match(body, /props\.onRefreshServerConfig\(\)/, '缺少 /api/config 刷新（它决定邮件行是否渲染）');
  assert.match(source, /onClick=\{\(\) => void refreshTwoFactorStatus\(\)\}/, '按钮必须仍然调用该处理函数');
});

// 设置页首帧必须就是对的：这两份状态由 App 的启动查询提供，不能再「进区才拉」——
// 那会让徽标 / 开关 / 按钮在加载完成后突然冒出来（并带布局跳动）。
test('设置页状态来自启动查询，且不再在进入分区时拉取', () => {
  const app = readSource('webapp/src/App.tsx');
  assert.match(
    app,
    /const emailVerificationQuery = useQuery\(\{[\s\S]{0,400}?vaultInitialDecryptDone,/,
    'App 必须在应用就绪时就拉邮箱验证状态'
  );
  assert.match(
    app,
    /const mailSettingsQuery = useQuery\(\{[\s\S]{0,400}?isAdmin && vaultInitialDecryptDone,/,
    '邮件配置查询必须只对管理员启用（那是管理员端点）'
  );
  assert.match(app, /emailVerification: emailVerificationQuery\.data \?\? null/, '查询结果要传给设置页');
  assert.match(app, /mailSettings: mailSettingsQuery\.data \?\? null/, '查询结果要传给设置页');

  const settings = readSource('webapp/src/components/SettingsPage.tsx');
  assert.doesNotMatch(settings, /activeSection !== 'account'/, '邮箱验证状态不能再挂在「进账户区」上');
  assert.doesNotMatch(settings, /activeSection !== 'mail'/, '邮件配置不能再挂在「进邮件区」上');
  assert.match(settings, /if \(props\.emailVerification\) setEmailVerification\(props\.emailVerification\)/, '启动查询结果要同步进本地状态');
  assert.match(settings, /if \(props\.mailSettings\) applyMailSettings\(props\.mailSettings\)/, '启动查询结果要灌进邮件表单');
});

// 「还没拿到」不等于「未配置」：初值当终态会先闪一个红色「未配置」。
test('未加载不渲染状态徽标：邮件徽标必须是三态', () => {
  const settings = readSource('webapp/src/components/SettingsPage.tsx');
  assert.match(
    settings,
    /mailSettings === null \? null : mailConfigured \?/,
    '未加载时不能渲染成「未配置」（那是误导）'
  );
  assert.match(settings, /mailSettings !== null && mailEnabled &&/, '「停用」按钮同理：拿到配置前不渲染');
});

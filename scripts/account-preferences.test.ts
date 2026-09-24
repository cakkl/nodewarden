// 用户级「语言 / 时区」偏好的行为测试。
//
// 盯住两件最容易错的事：
//   ① **条件写**：自动检测只在「未设定」或「当前是自动档」时才写；用户手动选定过的值
//      绝不能被登录时的浏览器值拉走（本功能的核心承诺）。
//   ② **普通用户可用**：端点不做管理员检查 —— 下面所有用例都以 `role: 'user'` 调用，
//      将来误加管理员检查会立刻变红。
//
// 运行方式：npm run test:account-preferences
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleDetectPreferences,
  handleGetPreferences,
  handleUpdatePreferences,
} from '../src/handlers/account-preferences';
import { StorageService } from '../src/services/storage';
import type { Env, User } from '../src/types';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'prefs-user';
const USER_EMAIL = 'prefs@example.test';

function jsonRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  // GET/HEAD 不允许带 body（undici 会直接抛错）
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
  }
  return new Request('https://vault.example.test/api/accounts/preferences', init);
}

type Handle = Awaited<ReturnType<typeof createSchemaDatabase>>;

async function setup() {
  const handle = await createSchemaDatabase();
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  const storage = new StorageService(handle.db);
  // 刻意是普通用户：证明端点不需要管理员
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL, role: 'user' });
  const currentUser = async (): Promise<User> => {
    const user = await storage.getUserById(USER_ID);
    assert.ok(user, '夹具应当能在库里找到用户');
    return user;
  };
  return { handle, env, currentUser };
}

/** 直接读库里的四列（绕开行映射，确保断言的是真正落库的值） */
function rawPrefs(handle: Handle): Record<string, unknown> {
  const row = handle.connection
    .prepare('SELECT locale, auto_locale, timezone, auto_timezone FROM users WHERE id = ?')
    .get(USER_ID) as Record<string, unknown>;
  return { ...row };
}

/** 「允许发通知邮件」单独读：它不参与语言/时区的自动检测，断言也分开。 */
function rawMailOptIn(handle: Handle): number {
  const row = handle.connection
    .prepare('SELECT mail_opt_in FROM users WHERE id = ?')
    .get(USER_ID) as { mail_opt_in: number };
  return Number(row.mail_opt_in);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test('未设定时：GET 返回 null + auto=false', async () => {
  const { handle, env, currentUser } = await setup();

  const response = await handleGetPreferences(jsonRequest('GET'), env, await currentUser());
  assert.equal(response.status, 200);
  assert.deepStrictEqual(await readJson(response), {
    object: 'preferences',
    locale: null,
    autoLocale: false,
    timezone: null,
    autoTimezone: false,
    mailOptIn: false,
  });

  handle.close();
});

test('PUT 设定语言与时区 ⇒ 落库并标记为「手动」（auto = 0）', async () => {
  const { handle, env, currentUser } = await setup();

  const response = await handleUpdatePreferences(
    jsonRequest('PUT', { locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
    env,
    await currentUser()
  );
  assert.equal(response.status, 200);
  assert.deepStrictEqual(await readJson(response), {
    object: 'preferences',
    locale: 'zh-CN',
    autoLocale: false,
    timezone: 'Asia/Shanghai',
    autoTimezone: false,
    mailOptIn: false,
  });
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: 'zh-CN',
    auto_locale: 0,
    timezone: 'Asia/Shanghai',
    auto_timezone: 0,
  });

  handle.close();
});

test('PUT：语言大小写不敏感地归一化到清单里的写法', async () => {
  const { handle, env, currentUser } = await setup();

  const response = await handleUpdatePreferences(
    jsonRequest('PUT', { locale: 'ZH-cn' }),
    env,
    await currentUser()
  );
  assert.equal(response.status, 200);
  assert.equal(rawPrefs(handle).locale, 'zh-CN');

  handle.close();
});

test('PUT：非法值返回 400（未知语言 / 非法时区 / 空请求体）', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  const badLocale = await handleUpdatePreferences(
    jsonRequest('PUT', { locale: 'klingon' }),
    env,
    user
  );
  assert.equal(badLocale.status, 400);

  const badTimezone = await handleUpdatePreferences(
    jsonRequest('PUT', { timezone: 'Not/AZone' }),
    env,
    user
  );
  assert.equal(badTimezone.status, 400);

  const empty = await handleUpdatePreferences(jsonRequest('PUT', {}), env, user);
  assert.equal(empty.status, 400);

  assert.deepStrictEqual(rawPrefs(handle), {
    locale: null,
    auto_locale: 0,
    timezone: null,
    auto_timezone: 0,
  }, '校验失败不得写入任何值');

  handle.close();
});

test('PUT：传 null 清空回「未设定」', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  await handleUpdatePreferences(
    jsonRequest('PUT', { locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
    env,
    user
  );
  const cleared = await handleUpdatePreferences(
    jsonRequest('PUT', { locale: null, timezone: null }),
    env,
    user
  );
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: null,
    auto_locale: 0,
    timezone: null,
    auto_timezone: 0,
  });

  handle.close();
});

test('detect：未设定时写入，并标记为「自动」', async () => {
  const { handle, env, currentUser } = await setup();

  const response = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'zh-TW', timezone: 'Asia/Taipei' }),
    env,
    await currentUser()
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.localeWritten, true);
  assert.equal(body.timezoneWritten, true);
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: 'zh-TW',
    auto_locale: 1,
    timezone: 'Asia/Taipei',
    auto_timezone: 1,
  });

  handle.close();
});

test('detect：用户手动选定后**绝不覆盖**（核心护栏）', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  await handleUpdatePreferences(
    jsonRequest('PUT', { locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
    env,
    user
  );

  // 模拟「用户刚在另一个标签页选好了，而这边一个握着陈旧状态的登录流程才上报浏览器值」
  const response = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'en', timezone: 'UTC' }),
    env,
    user
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.localeWritten, false);
  assert.equal(body.timezoneWritten, false);
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: 'zh-CN',
    auto_locale: 0,
    timezone: 'Asia/Shanghai',
    auto_timezone: 0,
  }, '手动选定过的值必须原样保留');

  handle.close();
});

test('detect：自动档下浏览器值变了 ⇒ 跟随更新', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  // 首次登录：按浏览器写入（自动档）
  await handleDetectPreferences(
    jsonRequest('POST', { locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
    env,
    user
  );
  // 后来搬到别的时区 / 换了浏览器语言，再登录
  const response = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'en', timezone: 'Europe/Berlin' }),
    env,
    user
  );
  const body = await readJson(response);
  assert.equal(body.localeWritten, true);
  assert.equal(body.timezoneWritten, true);
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: 'en',
    auto_locale: 1,
    timezone: 'Europe/Berlin',
    auto_timezone: 1,
  });

  handle.close();
});

test('detect：自动档且浏览器值没变 ⇒ 不写库（不白刷 updated_at）', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  // 首次登录：按浏览器写入（自动档）
  await handleDetectPreferences(
    jsonRequest('POST', { locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
    env,
    user
  );
  // 置成确定的旧值：「有没有被写」才能精确判定（否则两次调用落在同一毫秒会让断言变成空断言）。
  const sentinel = '2020-01-01T00:00:00.000Z';
  handle.connection.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(sentinel, USER_ID);

  const again = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
    env,
    user
  );
  const body = await readJson(again);
  assert.equal(body.localeWritten, false, '值没变时不应报告已写入');
  assert.equal(body.timezoneWritten, false);

  const row = handle.connection
    .prepare('SELECT updated_at FROM users WHERE id = ?')
    .get(USER_ID) as { updated_at: string };
  assert.equal(row.updated_at, sentinel, '值没变时不得写库（D1 按写入行数计费）');

  handle.close();
});

test('detect：非法值被跳过（来自浏览器，报 400 也无从补救），其余字段照常处理', async () => {
  const { handle, env, currentUser } = await setup();

  const response = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'klingon', timezone: 'Asia/Tokyo' }),
    env,
    await currentUser()
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.localeWritten, false, '非法语言必须被跳过而不是写进库');
  assert.equal(body.timezoneWritten, true, '合法时区仍应写入');
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: null,
    auto_locale: 0,
    timezone: 'Asia/Tokyo',
    auto_timezone: 1,
  });

  handle.close();
});

test('PUT 传 localeAuto: true ⇒ 值写当前浏览器值，且此后按浏览器刷新（「自动」档）', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  const response = await handleUpdatePreferences(
    jsonRequest('PUT', { locale: 'zh-CN', localeAuto: true }),
    env,
    user
  );
  assert.equal(response.status, 200);
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: 'zh-CN',
    auto_locale: 1,
    timezone: null,
    auto_timezone: 0,
  });

  // 自动档 ⇒ 登录时的浏览器值可以刷新它
  const detected = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'en' }),
    env,
    user
  );
  assert.equal((await readJson(detected)).localeWritten, true);
  assert.equal(rawPrefs(handle).locale, 'en');

  handle.close();
});

test('PUT 传 localeAuto: false ⇒ 把当前值「钉住」为手动', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  // 先进入自动档
  await handleUpdatePreferences(jsonRequest('PUT', { locale: 'zh-CN', localeAuto: true }), env, user);
  // 用户按「固定为这个值」
  const pinned = await handleUpdatePreferences(jsonRequest('PUT', { localeAuto: false }), env, user);
  assert.equal(pinned.status, 200);
  assert.deepStrictEqual(rawPrefs(handle), {
    locale: 'zh-CN',
    auto_locale: 0,
    timezone: null,
    auto_timezone: 0,
  }, '值应保留，只把来源改成手动');

  const detected = await handleDetectPreferences(jsonRequest('POST', { locale: 'en' }), env, user);
  assert.equal((await readJson(detected)).localeWritten, false, '手动档不得被自动刷新');

  handle.close();
});

test('PUT：localeAuto 非布尔 ⇒ 400', async () => {
  const { handle, env, currentUser } = await setup();

  const response = await handleUpdatePreferences(
    jsonRequest('PUT', { localeAuto: 'yes' }),
    env,
    await currentUser()
  );
  assert.equal(response.status, 400);

  handle.close();
});

test('「允许发通知邮件」：默认关闭，开启后落库为 1 且 GET 回读一致', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  // 默认关闭 —— 与「服务端能联系用户」构成双向自愿
  assert.equal(rawMailOptIn(handle), 0);
  const initial = await readJson(await handleGetPreferences(jsonRequest('GET'), env, user));
  assert.equal(initial.mailOptIn, false);

  const enabled = await handleUpdatePreferences(jsonRequest('PUT', { mailOptIn: true }), env, user);
  assert.equal(enabled.status, 200);
  assert.equal((await readJson(enabled)).mailOptIn, true);
  assert.equal(rawMailOptIn(handle), 1, '必须真正落库，而不只是回显');

  const readBack = await readJson(await handleGetPreferences(jsonRequest('GET'), env, user));
  assert.equal(readBack.mailOptIn, true, 'GET 应回读同一份值');

  handle.close();
});

test('「允许发通知邮件」：可以再关回去', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  await handleUpdatePreferences(jsonRequest('PUT', { mailOptIn: true }), env, user);
  assert.equal(rawMailOptIn(handle), 1);

  const disabled = await handleUpdatePreferences(jsonRequest('PUT', { mailOptIn: false }), env, user);
  assert.equal(disabled.status, 200);
  assert.equal((await readJson(disabled)).mailOptIn, false);
  assert.equal(rawMailOptIn(handle), 0);

  handle.close();
});

test('「允许发通知邮件」：非布尔 ⇒ 400，且不改动库里的值', async () => {
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  for (const bad of ['true', 1, null]) {
    const response = await handleUpdatePreferences(jsonRequest('PUT', { mailOptIn: bad }), env, user);
    assert.equal(response.status, 400, `mailOptIn=${JSON.stringify(bad)} 应被拒绝`);
  }
  assert.equal(rawMailOptIn(handle), 0, '被拒绝的请求不得改动已存的值');

  handle.close();
});

test('detect（登录时上报浏览器值）绝不改动「允许发通知邮件」', async () => {
  // 护栏：detect 的入参来自浏览器，只能承载「语言/时区」这类检测值。
  // 若将来有人把它加进 detect 的白名单，这条会红。
  const { handle, env, currentUser } = await setup();
  const user = await currentUser();

  await handleUpdatePreferences(jsonRequest('PUT', { mailOptIn: true }), env, user);

  const detected = await handleDetectPreferences(
    jsonRequest('POST', { locale: 'zh-CN', timezone: 'Asia/Shanghai', mailOptIn: false }),
    env,
    user
  );
  assert.equal(detected.status, 200);
  assert.equal(rawMailOptIn(handle), 1, 'detect 不得改写用户意愿');
  assert.equal((await readJson(detected)).mailOptIn, true, '响应应如实回读库里的值');

  handle.close();
});

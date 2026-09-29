// 默认两步登录提供程序（`users.two_factor_default_provider`）的行为测试：
// ① 登录挑战把默认项排到**首位**（客户端默认选中列表第一项），且一个 provider 都不能少；
// ② 默认值只表达偏好：存的项不可用时回退到第一个仍可用项，绝不让登录卡住；
// ③ 「第一个启用的自动成为默认」，之后用户自己选的默认不会被新启用的项抢走。
//
// 运行方式：npm run test:two-factor-default
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGetTwoFactorProviders,
  handlePutTwoFactorDefaultProvider,
} from '../src/handlers/accounts';
import { StorageService } from '../src/services/storage';
import { getUserById, saveUserPreferences } from '../src/services/storage-user-repo';
import {
  TWO_FACTOR_PROVIDER_AUTHENTICATOR,
  TWO_FACTOR_PROVIDER_EMAIL,
  TWO_FACTOR_PROVIDER_WEBAUTHN,
  TWO_FACTOR_PROVIDER_YUBIKEY,
  listConfiguredTwoFactorProviders,
  orderTwoFactorProvidersForChallenge,
  reconcileDefaultTwoFactorProvider,
  resolveDefaultTwoFactorProvider,
} from '../src/services/two-factor-default';
import type { Env } from '../src/types';
import { FIXED_NOW, TEST_JWT_SECRET, createSchemaDatabase, insertUser } from './lib/test-harness';

const USER_ID = '7c5ba1f4-1e2a-4c66-9a1d-3f7d5b1c9e10';
const USER_EMAIL = 'default-provider@example.test';

async function setup() {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID, { email: USER_EMAIL });
  const storage = new StorageService(handle.db);
  const user = await getUserById(handle.db, USER_ID);
  assert.ok(user, '测试用户应能被读出');
  const env = { DB: handle.db, JWT_SECRET: TEST_JWT_SECRET } as unknown as Env;
  return { handle, storage, env, user };
}

/** 直接写库改提供程序状态，再取回最新的 user（模拟「用户刚在设置页点过」）。 */
async function withState(
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>,
  changes: { totpSecret?: string | null; yubikey?: boolean; email?: boolean; passkey?: boolean }
) {
  if (changes.totpSecret !== undefined) {
    handle.connection.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(changes.totpSecret, USER_ID);
  }
  if (changes.yubikey !== undefined) {
    handle.connection
      .prepare('UPDATE users SET yubikey_key1 = ? WHERE id = ?')
      .run(changes.yubikey ? 'ccccccvbhnjk' : null, USER_ID);
  }
  if (changes.email !== undefined) {
    await saveUserPreferences(handle.db, USER_ID, { twoFactorEmailEnabled: changes.email });
  }
  if (changes.passkey === true) {
    handle.connection
      .prepare(
        'INSERT INTO webauthn_credentials (id, user_id, purpose, name, public_key, credential_id, counter, transports, supports_prf, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run('pk-1', USER_ID, 'twoFactor', 'passkey', 'pub', 'cred-1', 0, '[]', 0, FIXED_NOW, FIXED_NOW);
  }
  if (changes.passkey === false) {
    handle.connection.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(USER_ID);
  }
  const user = await getUserById(handle.db, USER_ID);
  assert.ok(user, '改完状态后用户应仍能读出');
  return user;
}

function readStoredDefault(handle: Awaited<ReturnType<typeof createSchemaDatabase>>): number | null {
  const row = handle.connection
    .prepare('SELECT two_factor_default_provider AS value FROM users WHERE id = ?')
    .get(USER_ID) as { value: number | null } | undefined;
  return row?.value ?? null;
}

// ─────────────────────── 已配置项与默认值解析 ───────────────────────

test('已配置提供程序：从用户状态 + 通行密钥凭据推导，并按规范顺序（邮件→验证器→通行密钥→YubiKey）', async () => {
  const { handle, storage } = await setup();
  const empty = await getUserById(handle.db, USER_ID);
  assert.deepEqual(await listConfiguredTwoFactorProviders(storage, empty!), [], '什么都没配 ⇒ 空');

  const user = await withState(handle, { yubikey: true, email: true, totpSecret: 'JBSWY3DPEHPK3PXP', passkey: true });
  assert.deepEqual(
    await listConfiguredTwoFactorProviders(storage, user),
    [TWO_FACTOR_PROVIDER_EMAIL, TWO_FACTOR_PROVIDER_AUTHENTICATOR, TWO_FACTOR_PROVIDER_WEBAUTHN, TWO_FACTOR_PROVIDER_YUBIKEY]
  );
});

test('解析默认值：存的值仍可用就沿用它（即便它不是规范顺序里的第一个）', async () => {
  const { handle, storage } = await setup();
  await withState(handle, { email: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
  handle.connection
    .prepare('UPDATE users SET two_factor_default_provider = ? WHERE id = ?')
    .run(TWO_FACTOR_PROVIDER_AUTHENTICATOR, USER_ID);

  const user = await getUserById(handle.db, USER_ID);
  assert.equal(await resolveDefaultTwoFactorProvider(storage, user!), TWO_FACTOR_PROVIDER_AUTHENTICATOR);
});

test('解析默认值：存的值已停用 ⇒ 回退到第一个仍可用项（登录绝不因「默认项没了」卡住）', async () => {
  const { handle, storage } = await setup();
  await withState(handle, { email: false, totpSecret: 'JBSWY3DPEHPK3PXP', yubikey: true });
  handle.connection
    .prepare('UPDATE users SET two_factor_default_provider = ? WHERE id = ?')
    .run(TWO_FACTOR_PROVIDER_EMAIL, USER_ID);

  const user = await getUserById(handle.db, USER_ID);
  assert.equal(await resolveDefaultTwoFactorProvider(storage, user!), TWO_FACTOR_PROVIDER_AUTHENTICATOR);
});

test('解析默认值：没有任何可用提供程序时为 null', async () => {
  const { handle, storage } = await setup();
  const user = await getUserById(handle.db, USER_ID);
  assert.equal(await resolveDefaultTwoFactorProvider(storage, user!), null);
});

// ─────────────────────── 写入路径的维护 ───────────────────────

test('维护：第一个启用的提供程序自动成为默认（并落库）', async () => {
  const { handle, storage } = await setup();
  const user = await withState(handle, { email: true });

  assert.equal(await reconcileDefaultTwoFactorProvider(handle.db, storage, user), TWO_FACTOR_PROVIDER_EMAIL);
  assert.equal(readStoredDefault(handle), TWO_FACTOR_PROVIDER_EMAIL, '自动选出的默认值必须落库');
});

test('维护：再启用一个提供程序不会抢走已设定的默认值', async () => {
  const { handle, storage } = await setup();
  let user = await withState(handle, { email: true });
  await reconcileDefaultTwoFactorProvider(handle.db, storage, user);

  user = await withState(handle, { totpSecret: 'JBSWY3DPEHPK3PXP' });
  assert.equal(await reconcileDefaultTwoFactorProvider(handle.db, storage, user), TWO_FACTOR_PROVIDER_EMAIL);
  assert.equal(readStoredDefault(handle), TWO_FACTOR_PROVIDER_EMAIL);
});

test('维护：停用默认项 ⇒ 落到下一个仍可用项', async () => {
  const { handle, storage } = await setup();
  let user = await withState(handle, { email: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
  await reconcileDefaultTwoFactorProvider(handle.db, storage, user);

  user = await withState(handle, { email: false });
  assert.equal(await reconcileDefaultTwoFactorProvider(handle.db, storage, user), TWO_FACTOR_PROVIDER_AUTHENTICATOR);
  assert.equal(readStoredDefault(handle), TWO_FACTOR_PROVIDER_AUTHENTICATOR);
});

test('维护：全部停用（恢复码路径）⇒ 清空默认值，不留「永远不生效」的偏好', async () => {
  const { handle, storage } = await setup();
  let user = await withState(handle, { email: true, yubikey: true, passkey: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
  await reconcileDefaultTwoFactorProvider(handle.db, storage, user);

  user = await withState(handle, { email: false, yubikey: false, passkey: false, totpSecret: null });
  assert.equal(await reconcileDefaultTwoFactorProvider(handle.db, storage, user), null);
  assert.equal(readStoredDefault(handle), null);
});

test('维护：幂等 —— 解析结果与已存值相同时不重复写库（updated_at 不变）', async () => {
  const { handle, storage } = await setup();
  const user = await withState(handle, { email: true });
  await reconcileDefaultTwoFactorProvider(handle.db, storage, user);
  const before = handle.connection.prepare('SELECT updated_at AS value FROM users WHERE id = ?').get(USER_ID) as { value: string };

  await reconcileDefaultTwoFactorProvider(handle.db, storage, user);
  const after = handle.connection.prepare('SELECT updated_at AS value FROM users WHERE id = ?').get(USER_ID) as { value: string };
  assert.equal(after.value, before.value, '值没变就不该写库');
});

// ─────────────────────── 登录挑战的排序 ───────────────────────

test('挑战排序：默认项排到首位，其余顺序保持不变（一个都不能少）', () => {
  const providers = ['0', '3', '1', '7'];
  const ordered = orderTwoFactorProvidersForChallenge(providers, TWO_FACTOR_PROVIDER_EMAIL);
  assert.deepEqual(ordered, ['1', '0', '3', '7']);
  assert.deepEqual([...ordered].sort(), [...providers].sort(), '只允许改顺序，不允许增删 provider');
});

test('挑战排序：默认项不在名单里或未设定 ⇒ 原样返回（服务端名单才是权威）', () => {
  assert.deepEqual(orderTwoFactorProvidersForChallenge(['0', '1'], TWO_FACTOR_PROVIDER_YUBIKEY), ['0', '1']);
  assert.deepEqual(orderTwoFactorProvidersForChallenge(['0', '1'], null), ['0', '1']);
});

// ─────────────────────── 端点 ───────────────────────

test('状态端点：返回解析后的 DefaultProvider（供设置页打勾）', async () => {
  const { handle, env } = await setup();
  await withState(handle, { email: true });
  const user = await getUserById(handle.db, USER_ID);
  await reconcileDefaultTwoFactorProvider(handle.db, new StorageService(handle.db), user!);

  const response = await handleGetTwoFactorProviders(new Request('https://vault.example/api/two-factor'), env, USER_ID);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.DefaultProvider, TWO_FACTOR_PROVIDER_EMAIL);
});

test('设置端点：已启用的提供程序可设为默认', async () => {
  const { handle, env } = await setup();
  await withState(handle, { email: true, totpSecret: 'JBSWY3DPEHPK3PXP' });

  const response = await handlePutTwoFactorDefaultProvider(
    new Request('https://vault.example/api/accounts/two-factor/default-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType: TWO_FACTOR_PROVIDER_AUTHENTICATOR }),
    }),
    env,
    USER_ID
  );

  assert.equal(response.status, 200);
  assert.equal(readStoredDefault(handle), TWO_FACTOR_PROVIDER_AUTHENTICATOR);
});

test('设置端点：未启用的提供程序 ⇒ 400 且不改库（否则会存下一个登录时不出现的默认值）', async () => {
  const { handle, env } = await setup();
  await withState(handle, { email: true });

  const response = await handlePutTwoFactorDefaultProvider(
    new Request('https://vault.example/api/accounts/two-factor/default-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType: TWO_FACTOR_PROVIDER_YUBIKEY }),
    }),
    env,
    USER_ID
  );

  assert.equal(response.status, 400);
  assert.equal(readStoredDefault(handle), null, '被拒绝时不应写入任何值');
});

// ─────────────────────── 源码护栏 ───────────────────────

test('源码护栏：登录挑战必须按默认值排序（identity.ts）', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const source = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'handlers', 'identity.ts'), 'utf8');

  assert.match(
    source,
    /orderTwoFactorProvidersForChallenge\(/,
    '挑战响应必须经过 orderTwoFactorProvidersForChallenge：客户端默认选中列表第一项，排序就是「默认方式」的唯一实现'
  );
  assert.doesNotMatch(
    source,
    /TwoFactorProviders: providers,/,
    '不能把未排序的 providers 直接塞进响应（会丢掉默认方式）'
  );
});

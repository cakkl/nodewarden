// 实时推送的护栏：Web 会话写入 ⇒ 推 103 并回吐发起**标签页**；程序侧写入 ⇒ 无 userId，
// 靠组织反查 owner；机器账号 / 授权 / 令牌 ⇒ 推 104；只读操作不推。
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { handleToken } from '../src/handlers/identity';
import { handleSecretsApiRoute, handleSecretsApiRouteForUser } from '../src/handlers/secrets-api';
import { handleSecretsMachineAccountRoute } from '../src/handlers/secrets-machine';
import { createMachineAccount } from '../src/services/storage-secrets-machine-repo';
import { ensureImplicitOrganization } from '../src/services/storage-secrets-repo';
import { createAccessToken } from '../src/services/storage-secrets-token-repo';
import type { Env } from '../src/types';
import { hashApiKey } from '../src/utils/api-key';
import { createSchemaDatabase, insertUser, TEST_JWT_SECRET } from './lib/test-harness';

const USER_ID = 'user-1';
const MACHINE_ID = 'machine-1';
const TOKEN_SECRET = 'client-secret-value';
const CLIENT_IP = '203.0.113.7';
const ENC = '2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|ccccccccccccccccccccccccccccccccccccccccccc=';
/** 与 `notifications-hub.ts` 保持一致（官方 SM 没有推送，所以是自己起的号段）。 */
const SIGNALR_UPDATE_TYPE_SM_SECRETS = 103;
const SIGNALR_UPDATE_TYPE_SM_MACHINE_ACCOUNTS = 104;

interface Push {
  userId: string;
  updateType: number;
  contextId: string | null;
}

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
  orgId: string;
  pushes: Push[];
}

function createHarnessStubs() {
  const pushes: Push[] = [];
  return {
    pushes,
    hub: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            updateType?: number;
            contextId?: string | null;
          };
          pushes.push({
            userId: id.toString(),
            updateType: Number(body.updateType),
            contextId: body.contextId ?? null,
          });
          return new Response('{}', { status: 200 });
        },
      }),
    },
  };
}

/** 推送走 `waitUntil`（不在请求的关键路径上）⇒ 断言前先让那条微任务跑完。 */
async function flushPushes(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, USER_ID);
  const stubs = createHarnessStubs();
  const env = {
    DB: handle.db,
    JWT_SECRET: TEST_JWT_SECRET,
    NOTIFICATIONS_HUB: stubs.hub,
  } as unknown as Env;
  const organization = await ensureImplicitOrganization(env.DB, USER_ID);
  await createMachineAccount(env.DB, {
    id: MACHINE_ID,
    orgId: organization.id,
    name: 'ci-bot',
    createdAt: '2026-01-01T00:00:00.000Z',
    revisionDate: '2026-01-01T00:00:00.000Z',
  });
  return { handle, connection: handle.connection, env, orgId: organization.id, pushes: stubs.pushes };
}

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let tokenCounter = 0;

/** 造一把 SM 访问令牌（CLI / SDK 那路）。 */
async function issueMachineToken(h: Harness): Promise<string> {
  tokenCounter += 1;
  const tokenId = `token-${tokenCounter}`;
  await createAccessToken(h.env.DB, {
    id: tokenId,
    machineAccountId: MACHINE_ID,
    orgId: h.orgId,
    name: 'ci token',
    secretHash: await hashApiKey(TOKEN_SECRET),
    encryptedPayload: ENC,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const response = await handleToken(
    new Request('https://x/identity/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': CLIENT_IP },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'api.secrets',
        client_id: tokenId,
        client_secret: TOKEN_SECRET,
      }).toString(),
    }),
    h.env
  );
  return ((await response.json()) as { access_token: string }).access_token;
}

test('Web 会话写入 ⇒ 推 103，并把标签页标识回吐成 ContextId', async () => {
  const h = await createHarness();
  try {
    const path = `/api/organizations/${h.orgId}/projects`;
    const response = await handleSecretsApiRouteForUser(
      jsonRequest(`https://x${path}`, 'POST', { name: ENC }, { 'X-NodeWarden-Sm-Context-Id': 'tab-abc' }),
      h.env,
      USER_ID,
      path,
      'POST'
    );
    assert.equal(response?.status, 200);
    await flushPushes();

    assert.equal(h.pushes.length, 1, '建项目应当推一次');
    assert.equal(h.pushes[0].userId, USER_ID, '会话那路直接就是自己');
    assert.equal(h.pushes[0].updateType, SIGNALR_UPDATE_TYPE_SM_SECRETS);
    assert.equal(h.pushes[0].contextId, 'tab-abc', '要把发起标签页回吐回去，页面才知道跳过刷新');
  } finally {
    h.handle.close();
  }
});

test('标签页标识优先于设备标识（否则同设备的两个标签页会互相挡掉）', async () => {
  const h = await createHarness();
  try {
    const path = `/api/organizations/${h.orgId}/projects`;
    await handleSecretsApiRouteForUser(
      // 两个头都带：服务端必须采用**标签页**那个
      jsonRequest(`https://x${path}`, 'POST', { name: ENC }, {
        'X-NodeWarden-Acting-Device-Id': 'device-shared',
        'X-NodeWarden-Sm-Context-Id': 'tab-this-one',
      }),
      h.env,
      USER_ID,
      path,
      'POST'
    );
    await flushPushes();

    assert.equal(h.pushes.length, 1);
    assert.equal(
      h.pushes[0].contextId,
      'tab-this-one',
      '按标签页抑制：拿设备标识比会把同设备的另一个标签页一起挡掉'
    );
  } finally {
    h.handle.close();
  }
});

test('CLI / SDK 写入 ⇒ 用组织 owner 反查出的 userId 推送', async () => {
  const h = await createHarness();
  try {
    const token = await issueMachineToken(h);
    const path = `/api/organizations/${h.orgId}/secrets`;
    const response = await handleSecretsApiRoute(
      jsonRequest(`https://x${path}`, 'POST', { key: ENC, value: ENC, note: ENC, projectIds: [] }, {
        Authorization: `Bearer ${token}`,
      }),
      h.env,
      path,
      'POST'
    );
    assert.equal(response?.status, 200);
    await flushPushes();

    assert.equal(h.pushes.length, 1, '建机密应当推一次');
    assert.equal(h.pushes[0].userId, USER_ID, '程序侧凭据里没有 userId ⇒ 只能靠组织反查');
    assert.equal(h.pushes[0].updateType, SIGNALR_UPDATE_TYPE_SM_SECRETS);
    assert.equal(h.pushes[0].contextId, null, 'CLI 不带设备标识 ⇒ 不做回声抑制');
  } finally {
    h.handle.close();
  }
});

test('机器账号 / 授权 / 令牌改动 ⇒ 推 104（与机密分开）', async () => {
  const h = await createHarness();
  try {
    const path = '/api/secrets/machine-accounts';
    const created = await handleSecretsMachineAccountRoute(
      jsonRequest(`https://x${path}`, 'POST', { name: 'new-bot' }),
      h.env,
      USER_ID,
      path,
      'POST'
    );
    assert.equal(created?.status, 200);
    await flushPushes();

    assert.equal(h.pushes.length, 1);
    assert.equal(h.pushes[0].updateType, SIGNALR_UPDATE_TYPE_SM_MACHINE_ACCOUNTS);
    assert.equal(h.pushes[0].userId, USER_ID);

    // 授权改动也要推（这类操作没有审计事件，靠的是显式调用）
    const accountId = ((await created!.json()) as { id: string }).id;
    const projectPath = `/api/organizations/${h.orgId}/projects`;
    const project = await handleSecretsApiRouteForUser(
      jsonRequest(`https://x${projectPath}`, 'POST', { name: ENC }),
      h.env,
      USER_ID,
      projectPath,
      'POST'
    );
    const projectId = ((await project!.json()) as { id: string }).id;
    await flushPushes();
    const before = h.pushes.length;

    const grantPath = `/api/secrets/machine-accounts/${accountId}/grants`;
    await handleSecretsMachineAccountRoute(
      jsonRequest(`https://x${grantPath}`, 'PUT', { projectId, permission: 'read' }),
      h.env,
      USER_ID,
      grantPath,
      'PUT'
    );
    await flushPushes();
    assert.equal(h.pushes.length, before + 1, '授权改动也要推');
    assert.equal(h.pushes.at(-1)?.updateType, SIGNALR_UPDATE_TYPE_SM_MACHINE_ACCOUNTS);
  } finally {
    h.handle.close();
  }
});

test('只读操作不发推送', async () => {
  const h = await createHarness();
  try {
    const token = await issueMachineToken(h);
    const listPath = `/api/organizations/${h.orgId}/secrets`;
    await handleSecretsApiRoute(
      jsonRequest(`https://x${listPath}`, 'GET', undefined, { Authorization: `Bearer ${token}` }),
      h.env,
      listPath,
      'GET'
    );
    await flushPushes();
    assert.equal(h.pushes.length, 0, '列机密不该推');
  } finally {
    h.handle.close();
  }
});

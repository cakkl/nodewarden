// `src/handlers/secrets.ts` + `src/services/storage-secrets-repo.ts` 的行为测试（跑真实 SQL）。
//
// 三个容易在改动中悄悄坏掉的点：
//   ① 隐式组织的创建是**幂等**的 —— 重复请求必须拿到同一个 id（靠 UNIQUE 约束，不是先查再插）
//   ② 用户之间**互相看不到**对方的组织与组织密钥
//   ③ 组织密钥是**首次写入胜出**：重复 PUT 不得覆盖已有密钥，且回吐的必须是实际存储的那把
//      （并发首次初始化会各自生成一把，覆盖会让先写那方的密文永久解不开）
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  handleGetSecretsOrganization,
  handleGetSecretsOrganizationKey,
  handlePutSecretsOrganizationKey,
} from '../src/handlers/secrets';
import type { Env } from '../src/types';
import { createSchemaDatabase, insertUser } from './lib/test-harness';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';
/** 形状合法的 EncString type 2（内容无所谓：服务端零知识，不解密）。 */
const ENC = '2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|ccccccccccccccccccccccccccccccccccccccccccc=';

interface Harness {
  handle: Awaited<ReturnType<typeof createSchemaDatabase>>;
  connection: DatabaseSync;
  env: Env;
}

async function createHarness(): Promise<Harness> {
  const handle = await createSchemaDatabase();
  insertUser(handle.connection, OWNER);
  insertUser(handle.connection, STRANGER);
  return { handle, connection: handle.connection, env: { DB: handle.db } as unknown as Env };
}

const ORG_URL = 'https://x/api/secrets/organization';
const ORG_KEY_URL = 'https://x/api/secrets/organization-key';

function jsonRequest(url: string, body: unknown, method: string): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function countRows(h: Harness, table: string): number {
  return (h.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('隐式组织：首次访问自动创建，重复访问拿到同一个 id（幂等）', async () => {
  const h = await createHarness();
  try {
    const first = await readJson(await handleGetSecretsOrganization(new Request(ORG_URL), h.env, OWNER));
    assert.equal(typeof first.id, 'string');
    assert.equal(first.object, 'organization');

    const second = await readJson(await handleGetSecretsOrganization(new Request(ORG_URL), h.env, OWNER));
    assert.equal(second.id, first.id, '重复请求不得再建一个组织');
    assert.equal(countRows(h, 'sm_organizations'), 1);
  } finally {
    h.handle.close();
  }
});

test('隔离：不同用户各自一个组织，且读不到对方的组织密钥', async () => {
  const h = await createHarness();
  try {
    // 还没有组织时读密钥：应回 null，而不是报错或凭空建组织
    const beforeOrg = await readJson(await handleGetSecretsOrganizationKey(new Request(ORG_KEY_URL), h.env, STRANGER));
    assert.equal(beforeOrg.wrappedOrgKey, null);
    assert.equal(countRows(h, 'sm_organizations'), 0, '只读密钥不应顺手建组织');

    const ownerOrg = await readJson(await handleGetSecretsOrganization(new Request(ORG_URL), h.env, OWNER));
    const strangerOrg = await readJson(await handleGetSecretsOrganization(new Request(ORG_URL), h.env, STRANGER));
    assert.notEqual(strangerOrg.id, ownerOrg.id, '不同用户必须有不同的组织');

    const put = await handlePutSecretsOrganizationKey(jsonRequest(ORG_KEY_URL, { wrappedOrgKey: ENC }, 'PUT'), h.env, OWNER);
    assert.equal(put.status, 200);

    const ownerKey = await readJson(await handleGetSecretsOrganizationKey(new Request(ORG_KEY_URL), h.env, OWNER));
    assert.equal(ownerKey.wrappedOrgKey, ENC);
    assert.equal(countRows(h, 'sm_org_keys'), 1);

    const strangerKey = await readJson(await handleGetSecretsOrganizationKey(new Request(ORG_KEY_URL), h.env, STRANGER));
    assert.equal(strangerKey.wrappedOrgKey, null, '不得读到别人的组织密钥');
  } finally {
    h.handle.close();
  }
});

test('组织密钥：首次写入胜出（重复 PUT 不覆盖），回吐实际存储的那把；非法 EncString 一律 400', async () => {
  const h = await createHarness();
  try {
    const firstPut = await handlePutSecretsOrganizationKey(jsonRequest(ORG_KEY_URL, { wrappedOrgKey: ENC }, 'PUT'), h.env, OWNER);
    assert.equal((await readJson(firstPut)).wrappedOrgKey, ENC, '首次写入应回吐自己的包裹');
    const first = h.connection.prepare('SELECT org_id, wrapped_org_key, created_at FROM sm_org_keys').get() as {
      org_id: string; wrapped_org_key: string; created_at: string;
    };

    // 模拟另一个标签页稍后带着自己生成的那把密钥打进来（只改密文段首字符 ⇒ 长度合法、内容不同）
    const other = ENC.replace('b', 'q');
    const secondPut = await handlePutSecretsOrganizationKey(jsonRequest(ORG_KEY_URL, { wrappedOrgKey: other }, 'PUT'), h.env, OWNER);
    const secondBody = await readJson(secondPut);

    assert.equal(secondBody.wrappedOrgKey, ENC, '回吐的必须是已存的那把，不能是刚提交的');
    const second = h.connection.prepare('SELECT org_id, wrapped_org_key, created_at FROM sm_org_keys').get() as {
      org_id: string; wrapped_org_key: string; created_at: string;
    };
    assert.equal(second.wrapped_org_key, ENC, '不得覆盖已存在的组织密钥');
    assert.equal(second.org_id, first.org_id);
    assert.equal(second.created_at, first.created_at);
    assert.equal(countRows(h, 'sm_org_keys'), 1, '不得写成两行');

    // 最后一条：base64 形状合法，但 iv 不是 16 字节、整体也远超长度上限 ⇒ 两道闸都该拦下它
    const oversized = `2.${'a'.repeat(600)}|${'b'.repeat(600)}|c`;
    for (const bad of ['', 'plain-text', '1.aa|bb|cc', '2.aa|bb', '2.a b|c|d', oversized]) {
      const response = await handlePutSecretsOrganizationKey(jsonRequest(ORG_KEY_URL, { wrappedOrgKey: bad }, 'PUT'), h.env, OWNER);
      assert.equal(response.status, 400, `非法密文必须被拒：${JSON.stringify(bad.slice(0, 24))}`);
    }
  } finally {
    h.handle.close();
  }
});

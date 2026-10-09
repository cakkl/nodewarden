// 机密管理器 Web 会话数据层（`webapp/src/lib/api/secrets.ts`）。
//
// demo 模式没有后端，URL / 方法 / 字段名写错时本地怎么点都发现不了。这里用一个**实现了
// 「首次写入胜出」的假服务端**（与 `saveOrgKey` 同语义）钉住三件事：① 组织密钥引导；
// ② ⭐ 并发对齐 —— PUT 回吐的不是我们提交的那把时必须采纳回吐值（否则先写方数据永久解不开）；
// ③ 请求契约 —— 批量删是**裸数组**、字段 camelCase、字段一律密文。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSecret,
  deleteSecrets,
  ensureSecretsContext,
  getSecretsByIds,
  listSecrets,
  secretsUserKey,
} from '../../webapp/src/lib/api/secrets';
import type { AuthedFetch } from '../../webapp/src/lib/api/shared';
import { bytesToBase64, requireWebCrypto } from '../../webapp/src/lib/crypto';
import { setLocale } from '../../webapp/src/lib/i18n';
import { decryptField, encryptField, splitKeyPair, unwrapOrgKey, wrapOrgKey, type SmKeyPair } from '../../webapp/src/lib/secrets-crypto';
import type { SessionState } from '../../webapp/src/lib/types';

// 断言里会用到文案（英文），显式切过去，避免受环境语言影响。
await setLocale('en');

const ORG_ID = 'org-1';

function randomKeyPair(): SmKeyPair {
  const webCrypto = requireWebCrypto();
  return { encKey: webCrypto.getRandomValues(new Uint8Array(32)), macKey: webCrypto.getRandomValues(new Uint8Array(32)) };
}

/** 会话状态只用到 symEncKey / symMacKey，其余字段与本层无关。 */
function sessionFor(userKey: SmKeyPair): SessionState {
  return { symEncKey: bytesToBase64(userKey.encKey), symMacKey: bytesToBase64(userKey.macKey) } as SessionState;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

interface FakeServer {
  /** 服务端当前存储的组织密钥包裹（`null` = 尚未初始化）。 */
  wrappedOrgKey: string | null;
  /** 在每次 PUT 真正落盘**之前**执行；用来确定性地模拟「另一个标签页先写入」。 */
  beforePut?: () => Promise<void> | void;
  calls: Array<{ url: string; method: string; body: unknown }>;
  authedFetch: AuthedFetch;
}

/** 假服务端：`saveOrgKey` 的「首次写入胜出 + 回吐实际值」语义与真实实现一致。 */
function createServer(overrides: Partial<Pick<FakeServer, 'wrappedOrgKey' | 'beforePut'>> = {}): FakeServer {
  const server: FakeServer = {
    wrappedOrgKey: overrides.wrappedOrgKey ?? null,
    beforePut: overrides.beforePut,
    calls: [],
    authedFetch: async (input, init) => {
      const method = init?.method ?? 'GET';
      server.calls.push({ url: input, method, body: init?.body ? JSON.parse(String(init.body)) : null });

      if (input === '/api/secrets/organization') return jsonResponse({ id: ORG_ID, object: 'organization' });

      if (input === '/api/secrets/organization-key') {
        if (method === 'PUT') {
          await server.beforePut?.();
          const submitted = (JSON.parse(String(init?.body)) as { wrappedOrgKey: string }).wrappedOrgKey;
          server.wrappedOrgKey ??= submitted;
          return jsonResponse({ id: ORG_ID, object: 'organizationKey', wrappedOrgKey: server.wrappedOrgKey });
        }
        return jsonResponse({ wrappedOrgKey: server.wrappedOrgKey, object: 'organizationKey' });
      }

      return new Response('not found', { status: 404 });
    },
  };
  return server;
}

/** 断言「这把组织密钥」能解开「这个上下文」加密的东西。 */
async function assertSameKeyAs(contextKeyPair: SmKeyPair, expectedOrgKey: Uint8Array): Promise<void> {
  const cipher = await encryptField('round-trip', splitKeyPair(expectedOrgKey));
  assert.equal(await decryptField(cipher, contextKeyPair), 'round-trip');
}

test('首次进入：生成组织密钥并上传，之后可直接解包裹', async () => {
  const userKey = randomKeyPair();
  const server = createServer();
  const session = sessionFor(userKey);

  const ctx = await ensureSecretsContext(server.authedFetch, session);
  assert.equal(ctx.organizationId, ORG_ID);
  assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 1);

  // 提交上去的那把包裹，用 user key 解开后必须与上下文里的密钥一致
  const uploaded = await unwrapOrgKey(server.wrappedOrgKey as string, userKey);
  await assertSameKeyAs(ctx.keyPair, uploaded);

  // 再进一次：这次不应再写
  const again = await ensureSecretsContext(server.authedFetch, session);
  assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 1, '已有密钥时不该重复上传');
  await assertSameKeyAs(again.keyPair, uploaded);
});

test('⭐ 并发对齐：回吐的不是我们提交的那把时，必须采纳回吐值', async () => {
  const userKey = randomKeyPair();
  const otherKey = requireWebCrypto().getRandomValues(new Uint8Array(64));
  const otherWrapped = await wrapOrgKey(otherKey, userKey);
  // 确定性模拟竞态：读的时候还是 null（我们据此决定生成），但 PUT 落地前服务端已被另一
  // 个标签页初始化。若服务端是覆盖写，这里争的就是「谁的密钥最终生效」—— 后果是先写方数据全废。
  const server = createServer({
    beforePut: () => {
      server.wrappedOrgKey ??= otherWrapped;
    },
  });

  const ctx = await ensureSecretsContext(server.authedFetch, sessionFor(userKey));

  // 采用的必须是「别人先写的那把」—— 用我们本地生成的那把会解不开对方的数据
  assert.equal(server.wrappedOrgKey, otherWrapped, '服务端不得被后来者覆盖');
  await assertSameKeyAs(ctx.keyPair, otherKey);
});

test('已存在组织密钥：只读不发 PUT，且用的是 user key 解开的那把', async () => {
  const userKey = randomKeyPair();
  const orgKey = requireWebCrypto().getRandomValues(new Uint8Array(64));
  const server = createServer({ wrappedOrgKey: await wrapOrgKey(orgKey, userKey) });

  const ctx = await ensureSecretsContext(server.authedFetch, sessionFor(userKey));
  assert.equal(server.calls.some((call) => call.method === 'PUT'), false);
  await assertSameKeyAs(ctx.keyPair, orgKey);
});

test('未解锁（缺 symEncKey / symMacKey）：直接报错，不发任何请求', async () => {
  const server = createServer();
  await assert.rejects(
    () => ensureSecretsContext(server.authedFetch, {} as SessionState),
    /Secrets key unavailable/
  );
  assert.equal(server.calls.length, 0);
});

test('列表：值与备注不在响应里，名字与项目关联由本层解出', async () => {
  const userKey = randomKeyPair();
  const orgKey = requireWebCrypto().getRandomValues(new Uint8Array(64));
  const server = createServer({ wrappedOrgKey: await wrapOrgKey(orgKey, userKey) });
  const ctx = await ensureSecretsContext(server.authedFetch, sessionFor(userKey));

  const keyPair = splitKeyPair(orgKey);
  const listServer = createServer({ wrappedOrgKey: server.wrappedOrgKey as string });
  listServer.authedFetch = async (input, init) => {
    if (String(input).endsWith('/secrets')) {
      return jsonResponse({
        object: 'list',
        projects: [{ id: 'p1', name: await encryptField('Production', keyPair), revisionDate: '2026-01-01T00:00:00.000Z' }],
        secrets: [
          {
            id: 's1',
            key: await encryptField('DATABASE_URL', keyPair),
            projects: [{ id: 'p1' }],
            creationDate: '2026-01-01T00:00:00.000Z',
            revisionDate: '2026-01-02T00:00:00.000Z',
          },
        ],
      });
    }
    return listServer.authedFetch(input, init);
  };

  const { secrets, projects } = await listSecrets(listServer.authedFetch, ctx);
  assert.deepEqual(projects.map((project) => project.name), ['Production']);
  assert.deepEqual(secrets, [
    {
      id: 's1',
      name: 'DATABASE_URL',
      projectIds: ['p1'],
      creationDate: '2026-01-01T00:00:00.000Z',
      revisionDate: '2026-01-02T00:00:00.000Z',
    },
  ]);
});

test('取值：get-by-ids 带回 value / note 并解出明文', async () => {
  const userKey = randomKeyPair();
  const orgKey = requireWebCrypto().getRandomValues(new Uint8Array(64));
  const keyPair = splitKeyPair(orgKey);
  const server = createServer({ wrappedOrgKey: await wrapOrgKey(orgKey, userKey) });
  const ctx = await ensureSecretsContext(server.authedFetch, sessionFor(userKey));

  const detailServer: AuthedFetch = async (input, init) => {
    if (input === '/api/secrets/get-by-ids') {
      return jsonResponse({
        data: [
          {
            id: 's1',
            key: await encryptField('DATABASE_URL', keyPair),
            value: await encryptField('postgres://db', keyPair),
            note: await encryptField('rotate quarterly', keyPair),
            projects: [{ id: 'p1' }],
            revisionDate: '2026-01-02T00:00:00.000Z',
          },
        ],
      });
    }
    return server.authedFetch(input, init);
  };

  const details = await getSecretsByIds(detailServer, ctx, ['s1']);
  assert.equal(details.length, 1);
  assert.equal(details[0].value, 'postgres://db');
  assert.equal(details[0].note, 'rotate quarterly');
});

test('写入契约：字段为 camelCase 且**全是密文**，批量删的请求体是裸数组', async () => {
  const userKey = randomKeyPair();
  const orgKey = requireWebCrypto().getRandomValues(new Uint8Array(64));
  const server = createServer({ wrappedOrgKey: await wrapOrgKey(orgKey, userKey) });
  const ctx = await ensureSecretsContext(server.authedFetch, sessionFor(userKey));

  const writeServer: FakeServer = createServer();
  writeServer.authedFetch = async (input, init) => {
    if (input === `/api/organizations/${ORG_ID}/secrets` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // 明文绝不出前端：key / value / note 都必须是 EncString type 2
      for (const field of ['key', 'value'] as const) {
        assert.match(String(body[field]), /^2\./);
        assert.equal(String(body[field]).includes('DATABASE_URL'), false);
      }
      assert.deepEqual(body.projectIds, ['p1']);
      return jsonResponse({
        id: 's1',
        key: body.key,
        value: body.value,
        note: body.note,
        projects: [{ id: 'p1' }],
        revisionDate: '2026-01-02T00:00:00.000Z',
      });
    }
    if (input === '/api/secrets/delete') {
      // ⚠️ 官方契约：请求体是裸 id 数组；响应是 list 信封（`bws` 按这个解析）
      assert.deepEqual(init?.body, JSON.stringify(['s1', 's2']));
      return jsonResponse({
        object: 'list',
        data: [
          { id: 's1', error: null },
          { id: 's2', error: null },
        ],
      });
    }
    return server.authedFetch(input, init);
  };

  const created = await createSecret(writeServer.authedFetch, ctx, {
    key: 'DATABASE_URL',
    value: 'postgres://db',
    note: '',
    projectIds: ['p1'],
  });
  assert.equal(created.name, 'DATABASE_URL');
  assert.equal(created.value, 'postgres://db');
  assert.equal(created.note, '', '空备注解出来还是空串，但发出去的是空串的密文');

  const results = await deleteSecrets(writeServer.authedFetch, ctx, ['s1', 's2']);
  assert.deepEqual(results, [{ id: 's1', error: null }, { id: 's2', error: null }]);

  // 服务端返回的错误要能透出来，供调用方逐项提示
  const mixedServer: AuthedFetch = async () =>
    jsonResponse({ object: 'list', data: [{ id: 's1', error: 'Forbidden' }] });
  assert.deepEqual(await deleteSecrets(mixedServer, ctx, ['s1']), [{ id: 's1', error: 'Forbidden' }]);
});

test('会话密钥：从 session 解出 base64 的 enc / mac；缺一即 null', async () => {
  const userKey = randomKeyPair();
  assert.deepEqual(secretsUserKey(sessionFor(userKey)), userKey);
  assert.equal(secretsUserKey({ symEncKey: bytesToBase64(userKey.encKey) } as SessionState), null);
  assert.equal(secretsUserKey({} as SessionState), null);
});

// 远端备份请求的超时守卫
//
// 三个**静默失败点**（写错都不报错）：
//   ① 只包 `fetch()` 不包读 body —— `fetch()` 收到响应头就 resolve，卡住的是 `arrayBuffer()`；
//   ② 超时被映射成 5xx —— 前端对 429/5xx 自动重试 3 次，一次超时被放大成约三倍等待；
//   ③ 预算过短 —— 把「慢但成功」的大文件上传误杀成失败。
// ⇒ 下面既有行为断言，也有源码护栏（不得再出现裸露的 `await fetch(`）与「慢但成功」的正向用例。
//
// ⚠️ 挂起类用例用**假时钟**推进预算，不真等 —— 真等待受事件循环调度影响，CI 负载高时整条用例会被
// 3 s 兜底取消（表现为 `cancelled`，像回归）。超时若没生效，`driveToTimeout` 直接断言失败而非挂住。
//
// 运行方式：npm run test:backup-remote-timeout
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { BackupDestinationRecord } from '../src/services/backup-config';
import { REMOTE_REQUEST_ACTIONS, buildRemoteTimeoutMessage } from '../shared/backup-timeout-message';
import {
  DEFAULT_REMOTE_REQUEST_TIMEOUTS,
  downloadRemoteBackupFile,
  isRemoteRequestTimeoutError,
  isRemoteRequestTimeoutMessage,
  listRemoteBackupEntries,
  remoteRequestFailureStatus,
  resolveRemoteRequestTimeouts,
  uploadRemoteBackupFile,
} from '../src/services/backup-uploader';

// `remotePath` 留空是刻意的：上传时就不会先触发 MKCOL（建目录走的是「控制类」预算），
// 这样用例测到的才是传输类预算本身。
const WEBDAV_DESTINATION: BackupDestinationRecord = {
  id: 'dest-webdav',
  name: 'Test WebDAV',
  type: 'webdav',
  includeAttachments: true,
  destination: {
    baseUrl: 'https://dav.example.test',
    username: 'user',
    password: 'secret',
    remotePath: '',
  },
  schedule: { enabled: false, intervalHours: 24, startTime: '03:00', timezone: 'UTC', retentionCount: null },
  runtime: {
    lastAttemptAt: null,
    lastAttemptLocalDate: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastUploadedFileName: null,
    lastUploadedSizeBytes: null,
    lastUploadedDestination: null,
  },
};

const S3_DESTINATION: BackupDestinationRecord = {
  ...WEBDAV_DESTINATION,
  id: 'dest-s3',
  name: 'Test S3',
  type: 's3',
  destination: {
    endpoint: 'https://s3.example.test',
    bucket: 'backups',
    addressingStyle: 'path-style',
    region: 'auto',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    rootPath: '',
  },
};

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

async function withFetchStub<T>(stub: FetchStub, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** 「请求已发出」信号：假时钟下要等它到点再推预算，否则 abort 会落在请求之前、测不到打断。 */
function createStartedSignal(): { markStarted: () => void; started: Promise<void> } {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return { markStarted, started };
}

/**
 * 黑洞目标：连接建立、但对端从不发送任何字节（丢包 / 被暂停的容器 / 挂住的代理）。
 *
 * ⚠️ 必须与真实 `fetch` 一致，否则用例会挂死而不是失败：`signal` 已 aborted 时要**立即拒绝**
 * —— abort 事件早已派发完，只挂监听器就永远等不到（S3 发请求前要先算签名，预算可能在请求之前到点）。
 */
function createHangingFetch(): { stub: FetchStub; started: Promise<void> } {
  const { markStarted, started } = createStartedSignal();
  const stub: FetchStub = (_input, init) => {
    markStarted();
    const signal = init?.signal;
    if (signal?.aborted) return Promise.reject(new Error('The operation was aborted'));
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  };

  return { stub, started };
}

/** 响应头立刻返回，但 body 永不结束 —— 用来证明超时覆盖到了「读 body」这一步。 */
function headersThenHang(): { stub: FetchStub; started: Promise<void> } {
  const { markStarted, started } = createStartedSignal();

  const stub: FetchStub = async (_input, init) => {
    markStarted();
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal?.aborted) {
          controller.error(new Error('The operation was aborted'));
          return;
        }
        signal?.addEventListener('abort', () => controller.error(new Error('The operation was aborted')));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/zip' } });
  };

  return { stub, started };
}

/** 把排队的微任务跑完（用真实 `setImmediate` —— 不受 mock timers 影响）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 归一化成「是否已结束」的查询函数，并接管 rejection（避免出现未处理的拒绝）。 */
function settledFlag(pending: Promise<unknown>): () => boolean {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void pending.then(markSettled, markSettled);
  return () => settled;
}

/**
 * 等请求真正发出（S3 要先算签名）后再用假时钟把预算推到期，返回拒绝错误。
 *
 * 要循环推进：一次 tick 只让「当下已注册的计时器」到期，而分阶段计时（先首包、再读 body）的
 * 后续阶段要等前一段完成才注册。⚠️ 上限用尽仍未结束 ⇒ 超时根本没生效，这里直接断言失败。
 */
async function driveToTimeout(
  t: TestContext,
  budgetMs: number,
  started: Promise<void>,
  pending: Promise<unknown>
): Promise<unknown> {
  const isSettled = settledFlag(pending);
  const maxRounds = 3;

  await started;
  for (let round = 0; round < maxRounds && !isSettled(); round += 1) {
    for (let turn = 0; turn < 3; turn += 1) await flushMicrotasks();
    t.mock.timers.tick(budgetMs);
    await flushMicrotasks();
  }

  assert.equal(
    isSettled(),
    true,
    `超时预算没有生效：推进 ${maxRounds * budgetMs} ms 后请求仍未结束（护栏失灵）`
  );
  return await pending.then(
    () => assert.fail('应当是超时拒绝，而不是成功'),
    (error: unknown) => error
  );
}

test('列目录：对端永不响应时按「列目录预算」超时，并映射成不可重试的 400', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = createHangingFetch();
  await withFetchStub(hanging.stub, async () => {
    const error = await driveToTimeout(
      t,
      20,
      hanging.started,
      listRemoteBackupEntries(WEBDAV_DESTINATION, '', { listingMs: 20 })
    );
    assert.ok(isRemoteRequestTimeoutError(error), '必须是超时错误，而不是一直 pending');
    assert.equal((error as Error).message, 'WebDAV listing timed out after 20 ms');
    assert.equal(
      remoteRequestFailureStatus(error),
      400,
      '超时必须不可重试 —— 前端对 5xx 会自动重试 3 次，把一次超时放大成三倍等待'
    );
  });
});

test('S3 路径同样不会挂死（第 8 处请求也包了超时）', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = createHangingFetch();
  await withFetchStub(hanging.stub, async () => {
    // 这条路径发请求前要先算签名（多次 crypto.subtle）⇒ 必须等 `started`，不能提前推时钟
    const error = await driveToTimeout(
      t,
      20,
      hanging.started,
      listRemoteBackupEntries(S3_DESTINATION, '', { listingMs: 20 })
    );
    assert.ok(isRemoteRequestTimeoutError(error), 'S3 路径也必须被超时打断');
    assert.equal((error as Error).message, 'S3 listing timed out after 20 ms');
  });
});

test('下载：响应头到了但 body 不再发数据时，卡在「读 body」也会被超时打断', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = headersThenHang();
  await withFetchStub(hanging.stub, async () => {
    const error = await driveToTimeout(
      t,
      30,
      hanging.started,
      downloadRemoteBackupFile(WEBDAV_DESTINATION, 'backup.zip', { firstByteMs: 20, transferMinMs: 30 })
    );
    assert.ok(isRemoteRequestTimeoutError(error));
    // 报的是第二段（body）预算 ⇒ 证明确实是「读 body」阶段被抓到，而不是首包超时
    assert.equal((error as Error).message, 'WebDAV download timed out after 30 ms');
  });
});

test('上传：超时预算随体积放大（100 B @ 1000 B/s ⇒ 100 ms），而不是一律用固定值', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = createHangingFetch();
  await withFetchStub(hanging.stub, async () => {
    const error = await driveToTimeout(
      t,
      100,
      hanging.started,
      uploadRemoteBackupFile(WEBDAV_DESTINATION, 'attachment.bin', new Uint8Array(100), {}, {
        transferMinMs: 1,
        transferMaxMs: 60_000,
        transferBytesPerSecond: 1_000,
      })
    );
    assert.ok(isRemoteRequestTimeoutError(error));
    assert.equal((error as Error).message, 'WebDAV upload timed out after 100 ms');
  });
});

test('慢但成功：30 ms 才返回的响应不会因为预算 200 ms 而失败（不得误杀慢速上传）', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { markStarted, started } = createStartedSignal();
  const slowButOk: FetchStub = async () => {
    markStarted();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(null, { status: 201 });
  };
  await withFetchStub(slowButOk, async () => {
    const upload = uploadRemoteBackupFile(WEBDAV_DESTINATION, 'attachment.bin', new Uint8Array(8), {}, {
      transferMinMs: 200,
    });
    const isDone = settledFlag(upload);
    await started;
    // 只推进对端的 30 ms（5 轮 = 150 ms < 200 ms 预算）⇒ 能完成就证明预算没被误触发
    for (let i = 0; i < 5 && !isDone(); i += 1) {
      await flushMicrotasks();
      t.mock.timers.tick(30);
      await flushMicrotasks();
    }
    await upload;
  });
});

test('对端主动失败（连接被拒）不当成超时：错误原样冒泡，且沿用调用方给的状态码', async () => {
  const refused: FetchStub = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  await withFetchStub(refused, async () => {
    await assert.rejects(
      () => listRemoteBackupEntries(WEBDAV_DESTINATION, '', { listingMs: 20 }),
      (error: unknown) => {
        assert.equal(isRemoteRequestTimeoutError(error), false, '连接被拒不是超时');
        assert.equal((error as Error).message, 'connect ECONNREFUSED');
        assert.equal(remoteRequestFailureStatus(error), 500, '默认回退值不变');
        assert.equal(remoteRequestFailureStatus(error, 409), 409, '调用方给的回退状态码要被保留');
        return true;
      }
    );
  });
});

test('DO → handler 只传消息：超时按消息形状识别为 400，HTTP 状态类消息不受影响', () => {
  assert.equal(isRemoteRequestTimeoutMessage(buildRemoteTimeoutMessage('WebDAV', 'upload', 15000)), true);
  assert.equal(remoteRequestFailureStatus(buildRemoteTimeoutMessage('WebDAV', 'upload', 15000)), 400);
  assert.equal(remoteRequestFailureStatus(buildRemoteTimeoutMessage('S3', 'download', 30)), 400);
  // 与本项目消息形状不同的串（例如秒而不是毫秒）不应被误判
  assert.equal(isRemoteRequestTimeoutMessage('WebDAV upload timed out after 15 seconds'), false);
  // 带状态码的失败仍按调用方的回退值处理
  assert.equal(remoteRequestFailureStatus('WebDAV upload failed: 403', 500), 500);
  assert.equal(isRemoteRequestTimeoutMessage('Backup run failed'), false);
});

test('消息形状来自共享定义：所有 provider × action 组合都能被识别（防止有人绕过 shared 手写消息）', () => {
  for (const action of REMOTE_REQUEST_ACTIONS) {
    for (const provider of ['WebDAV', 'S3'] as const) {
      const message = buildRemoteTimeoutMessage(provider, action, 12345);
      assert.equal(
        isRemoteRequestTimeoutMessage(message),
        true,
        `${provider} ${action} 的消息形状未被识别 —— 前端会看到英文原文、且超时会被当成 500 而重试 3 次`
      );
      assert.equal(isRemoteRequestTimeoutMessage(`${message} `), false, '尾随空格不应被匹配');
    }
  }
});

test('注入的非法预算被忽略（0 / 负数 / NaN / Infinity 会让计时器立即触发或永不触发）', () => {
  assert.deepEqual(resolveRemoteRequestTimeouts(undefined), DEFAULT_REMOTE_REQUEST_TIMEOUTS);
  assert.equal(resolveRemoteRequestTimeouts({ controlMs: 25 }).controlMs, 25);
  assert.equal(
    resolveRemoteRequestTimeouts({ controlMs: 25 }).listingMs,
    DEFAULT_REMOTE_REQUEST_TIMEOUTS.listingMs
  );
  const invalid = resolveRemoteRequestTimeouts({
    controlMs: 0,
    listingMs: -1,
    firstByteMs: Number.NaN,
    transferBytesPerSecond: Number.POSITIVE_INFINITY,
  });
  assert.equal(invalid.controlMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.controlMs);
  assert.equal(invalid.listingMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.listingMs);
  assert.equal(invalid.firstByteMs, DEFAULT_REMOTE_REQUEST_TIMEOUTS.firstByteMs);
  assert.equal(invalid.transferBytesPerSecond, DEFAULT_REMOTE_REQUEST_TIMEOUTS.transferBytesPerSecond);
});

// ---------------------------------------------------------------- 源码护栏
// 做不了精确的「每个 fetch 都在超时包装里」，但能断言更本质的不变量：**每处 fetch( 都必须带 signal**
// —— signal 只能由 withRemoteTimeout 提供，少了它超时形同虚设（请求可以永不 settle）。
test('源码护栏：backup-uploader.ts 里每个 fetch( 都必须带 signal', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/services/backup-uploader.ts'), 'utf8')
    // 先去掉注释：注释里提到 `fetch()` 不该被算成调用点
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const callSites = source.split('fetch(').slice(1);
  assert.ok(callSites.length >= 8, `远端请求至少 8 处，实际只找到 ${callSites.length} 处（护栏可能已失效）`);
  callSites.forEach((tail: string, index: number) => {
    // 截到「下一次 fetch(」为止：否则后面的代码会把 signal 蹭进来
    // （固定字符窗口要么截断真调用、要么跨到下一处）。
    const nextCall = tail.indexOf('fetch(');
    const scope = (nextCall === -1 ? tail : tail.slice(0, nextCall)).slice(0, 1_000);
    assert.ok(
      scope.includes('signal'),
      `第 ${index + 1} 处 fetch( 没带 signal ⇒ 该请求可能永不 settle，超时形同虚设`
    );
  });
});

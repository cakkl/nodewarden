// 远端备份请求的超时守卫
//
// 为什么值得测：这组超时把一类「永远不返回」的故障变成「可读的失败」，但它有三个
// **静默失败点** —— 任何一个写错都不会报错，只会在真实故障时表现为又一条通用 500、
// 或一段漫长的等待：
//   ① 只包 `fetch()` 不包读 body —— `fetch()` 收到响应头就 resolve，
//      对端「发了头就不再发数据」时卡住的是 `await response.arrayBuffer()`；
//   ② 超时被映射成 5xx —— 前端 `retryableRequest` 对 429/5xx 自动重试 3 次，
//      一次超时会被放大成约三倍等待；
//   ③ 预算过短 —— 把「慢但成功」的大文件上传误杀成失败。
//
// 因此下面既有行为断言，也有源码护栏（不得再出现裸露的 `await fetch(`）与「慢但成功」的正向用例。
//
// 运行方式：npm run test:backup-remote-timeout
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { BackupDestinationRecord } from '../src/services/backup-config';
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

/**
 * 黑洞目标：连接建立、但对端从不发送任何字节（丢包 / 被暂停的容器 / 挂住的代理）。
 * 必须尊重 abort —— 与真实 `fetch` 被 abort 后的行为一致，否则用例只会一直挂着。
 */
function neverResponds(): FetchStub {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
}

/** 响应头立刻返回，但 body 永不结束 —— 用来证明超时覆盖到了「读 body」这一步。 */
function headersThenHang(): FetchStub {
  return async (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('The operation was aborted')));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/zip' } });
  };
}

// 挂起类用例都带显式 timeout：若超时未生效，期望的是一个**快速失败**（“测试超时”），
// 而不是让整个测试进程永远挂住 —— 这直接决定了这个文件能不能抓回退。
test('列目录：对端永不响应时按「列目录预算」超时，并映射成不可重试的 400', { timeout: 3_000 }, async () => {
  await withFetchStub(neverResponds(), async () => {
    await assert.rejects(
      () => listRemoteBackupEntries(WEBDAV_DESTINATION, '', { listingMs: 20 }),
      (error: unknown) => {
        assert.ok(isRemoteRequestTimeoutError(error), '必须是超时错误，而不是一直 pending');
        assert.equal((error as Error).message, 'WebDAV listing timed out after 20 ms');
        assert.equal(
          remoteRequestFailureStatus(error),
          400,
          '超时必须不可重试 —— 前端对 5xx 会自动重试 3 次，把一次超时放大成三倍等待'
        );
        return true;
      }
    );
  });
});

test('S3 路径同样不会挂死（第 8 处请求也包了超时）', { timeout: 3_000 }, async () => {
  await withFetchStub(neverResponds(), async () => {
    await assert.rejects(
      () => listRemoteBackupEntries(S3_DESTINATION, '', { listingMs: 20 }),
      (error: unknown) =>
        isRemoteRequestTimeoutError(error)
        && (error as Error).message === 'S3 listing timed out after 20 ms'
    );
  });
});

test('下载：响应头到了但 body 不再发数据时，卡在「读 body」也会被超时打断', { timeout: 3_000 }, async () => {
  await withFetchStub(headersThenHang(), async () => {
    await assert.rejects(
      () => downloadRemoteBackupFile(WEBDAV_DESTINATION, 'backup.zip', { firstByteMs: 20, transferMinMs: 30 }),
      (error: unknown) => {
        assert.ok(isRemoteRequestTimeoutError(error));
        // 报的是第二段（body）预算 ⇒ 证明确实是「读 body」阶段被抓到，而不是首包超时
        assert.equal((error as Error).message, 'WebDAV download timed out after 30 ms');
        return true;
      }
    );
  });
});

test('上传：超时预算随体积放大（100 B @ 1000 B/s ⇒ 100 ms），而不是一律用固定值', { timeout: 3_000 }, async () => {
  await withFetchStub(neverResponds(), async () => {
    await assert.rejects(
      () =>
        uploadRemoteBackupFile(WEBDAV_DESTINATION, 'attachment.bin', new Uint8Array(100), {}, {
          transferMinMs: 1,
          transferMaxMs: 60_000,
          transferBytesPerSecond: 1_000,
        }),
      (error: unknown) =>
        isRemoteRequestTimeoutError(error)
        && (error as Error).message === 'WebDAV upload timed out after 100 ms'
    );
  });
});

test('慢但成功：30 ms 才返回的响应不会因为预算 200 ms 而失败（不得误杀慢速上传）', async () => {
  const slowButOk: FetchStub = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(null, { status: 201 });
  };
  await withFetchStub(slowButOk, async () => {
    await uploadRemoteBackupFile(WEBDAV_DESTINATION, 'attachment.bin', new Uint8Array(8), {}, {
      transferMinMs: 200,
    });
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
  assert.equal(isRemoteRequestTimeoutMessage('WebDAV upload timed out after 15000 ms'), true);
  assert.equal(remoteRequestFailureStatus('WebDAV upload timed out after 15000 ms'), 400);
  assert.equal(remoteRequestFailureStatus('S3 download timed out after 30 ms'), 400);
  // 与本项目消息形状不同的串（例如秒而不是毫秒）不应被误判
  assert.equal(isRemoteRequestTimeoutMessage('WebDAV upload timed out after 15 seconds'), false);
  // 带状态码的失败仍按调用方的回退值处理
  assert.equal(remoteRequestFailureStatus('WebDAV upload failed: 403', 500), 500);
  assert.equal(isRemoteRequestTimeoutMessage('Backup run failed'), false);
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
// 断言不了「每个 fetch 都在超时包装里」（文本上做不精确），但可以断言一条更本质的不变量：
// **每处 fetch( 都必须带 signal** —— signal 只能由 withRemoteTimeout 提供，
// 少了它超时就是形同虚设（请求可以永不 settle）。
test('源码护栏：backup-uploader.ts 里每个 fetch( 都必须带 signal', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/services/backup-uploader.ts'), 'utf8')
    // 先去掉注释：注释里提到 `fetch()` 不该被算成调用点
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const callSites = source.split('fetch(').slice(1);
  assert.ok(callSites.length >= 8, `远端请求至少 8 处，实际只找到 ${callSites.length} 处（护栏可能已失效）`);
  callSites.forEach((tail: string, index: number) => {
    // 截到「下一次 fetch(」为止：这样断言的范围就是这一处调用自身，
    // 不会靠后面的代码把 signal 蹭进来（固定字符窗口要么截断真调用、要么跨到下一处）。
    const nextCall = tail.indexOf('fetch(');
    const scope = (nextCall === -1 ? tail : tail.slice(0, nextCall)).slice(0, 1_000);
    assert.ok(
      scope.includes('signal'),
      `第 ${index + 1} 处 fetch( 没带 signal ⇒ 该请求可能永不 settle，超时形同虚设`
    );
  });
});

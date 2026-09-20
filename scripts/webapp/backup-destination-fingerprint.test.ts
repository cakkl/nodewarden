// 备份目标「访问配置」指纹的测试。
//
// 背景：备份中心里「远端目录自动刷新」的 effect 原先只以**目标 id** 为触发条件，
// 于是「同一个目标把 WebDAV 地址从空填成有效值并保存」时 id 没变 ⇒ effect 不重跑 ⇒
// 列表空着，要用户手动点一次「刷新」。现在触发条件改为「目标 id + 访问配置指纹」，
// 保存后「要不要作废缓存」也改用同一个指纹判断。
//
// 这里测两个**纯函数**（组件只负责调用它们），盯住几件容易静默出错的事：
//   `getBackupDestinationAccessFingerprint()`
//   ① 指纹只能对「访问配置」敏感 —— 改名 / 改调度 / 跑过一次备份都不该变，
//      否则每次保存设置都白跑一次远端列举（还得过一次网络往返）；
//   ② 指纹里**不能**含密码 / secretAccessKey —— 比较变更而已，没必要把密钥复制一份；
//   ③ 用 JSON 编码相邻字段，避免 `username` 的尾巴与 `remotePath` 的头互相顶替。
//   `shouldInvalidateRemoteBrowserCache()`
//   ④ 只改名字 / 调度时**不能**清缓存 —— 清了列表会空着，而 effect 不会重载。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { type BackupDestinationRecord, createBackupDestinationRecord } from '../../shared/backup-schema';
import {
  getBackupDestinationAccessFingerprint,
  shouldInvalidateRemoteBrowserCache,
} from '../../webapp/src/lib/backup-center';

/** 造一个目标记录；`config` 覆盖 `destination`（连接配置）里的字段，其余走默认值 */
function createDestination(
  type: 'webdav' | 's3',
  config: Record<string, unknown> = {},
  record: Partial<BackupDestinationRecord> = {}
): BackupDestinationRecord {
  const base = createBackupDestinationRecord(type, 1, { id: 'dest-1', timezone: 'UTC' });
  const defaultConfig = base.destination as unknown as Record<string, unknown>;
  return {
    ...base,
    ...record,
    // 连接配置是联合类型（S3 / WebDAV 字段名不同），这里按字段名表覆盖，故先降到 unknown
    destination: { ...defaultConfig, ...config } as unknown as BackupDestinationRecord['destination'],
  };
}

test('没有目标：返回空指纹（拿不到对象时不能抛错）', () => {
  assert.equal(getBackupDestinationAccessFingerprint(null), '');
  assert.equal(getBackupDestinationAccessFingerprint(undefined), '');
});

test('改名 / 改调度 / 跑过一次备份：指纹不变', () => {
  const before = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'alice' });
  const after: BackupDestinationRecord = {
    ...before,
    name: '改了个名字',
    schedule: { ...before.schedule, intervalHours: 12, retentionCount: 3 },
    runtime: {
      ...before.runtime,
      lastAttemptAt: '2026-09-20T03:00:00.000Z',
      lastSuccessAt: '2026-09-20T03:00:12.000Z',
      lastUploadedFileName: 'nodewarden-backup.zip',
    },
  };

  assert.equal(
    getBackupDestinationAccessFingerprint(after),
    getBackupDestinationAccessFingerprint(before),
    '这些变化跟「列目录」无关，不该触发重新列举'
  );
});

test('WebDAV：地址 / 账号 / 远端目录变化都会改变指纹', () => {
  const base = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'alice', remotePath: '/vault' });
  const basePrint = getBackupDestinationAccessFingerprint(base);

  const otherUrl = createDestination('webdav', { baseUrl: 'https://dav.example.com/other', username: 'alice', remotePath: '/vault' });
  const otherUser = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'bob', remotePath: '/vault' });
  const otherPath = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'alice', remotePath: '/other' });

  assert.notEqual(getBackupDestinationAccessFingerprint(otherUrl), basePrint);
  assert.notEqual(getBackupDestinationAccessFingerprint(otherUser), basePrint);
  assert.notEqual(getBackupDestinationAccessFingerprint(otherPath), basePrint);
});

test('从「尚未配置」变成「已配置」：指纹必须改变', () => {
  // 这就是本次修的场景：占位目标（baseUrl 为空）填好地址并保存后，要能自动列举一次
  const empty = createDestination('webdav');
  const filled = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup' });

  assert.equal(empty.destination ? (empty.destination as unknown as Record<string, unknown>).baseUrl : null, '');
  assert.notEqual(getBackupDestinationAccessFingerprint(filled), getBackupDestinationAccessFingerprint(empty));
});

test('S3：endpoint / bucket / region / 寻址风格 / 根路径变化都会改变指纹', () => {
  const base = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'vault', rootPath: '/nw' });
  const basePrint = getBackupDestinationAccessFingerprint(base);

  const otherBucket = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'other', rootPath: '/nw' });
  const otherRegion = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'vault', rootPath: '/nw', region: 'eu-central-1' });
  const otherStyle = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'vault', rootPath: '/nw', addressingStyle: 'virtual-hosted-style' });
  const otherPath = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'vault', rootPath: '/other' });

  assert.notEqual(getBackupDestinationAccessFingerprint(otherBucket), basePrint);
  assert.notEqual(getBackupDestinationAccessFingerprint(otherRegion), basePrint);
  assert.notEqual(getBackupDestinationAccessFingerprint(otherStyle), basePrint);
  assert.notEqual(getBackupDestinationAccessFingerprint(otherPath), basePrint);
});

test('只改密码 / 密钥：指纹不变（刻意不含密钥字段）', () => {
  const oldSecret = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', password: 'old-secret' });
  const newSecret = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', password: 'new-secret' });
  const oldS3Secret = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'vault', secretAccessKey: 'old-key' });
  const newS3Secret = createDestination('s3', { endpoint: 'https://s3.example.com', bucket: 'vault', secretAccessKey: 'new-key' });

  assert.equal(getBackupDestinationAccessFingerprint(newSecret), getBackupDestinationAccessFingerprint(oldSecret));
  assert.equal(getBackupDestinationAccessFingerprint(newS3Secret), getBackupDestinationAccessFingerprint(oldS3Secret));
});

test('首尾空白不算改动（免得只多打一个空格就重新列举一次）', () => {
  const trimmed = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup' });
  const padded = createDestination('webdav', { baseUrl: '  https://dav.example.com/backup  ' });

  assert.equal(getBackupDestinationAccessFingerprint(padded), getBackupDestinationAccessFingerprint(trimmed));
});

test('相邻字段不会互相顶替（用 JSON 编码，而不是裸拼接）', () => {
  const a = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'ab', remotePath: 'c' });
  const b = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'a', remotePath: 'bc' });

  assert.notEqual(getBackupDestinationAccessFingerprint(b), getBackupDestinationAccessFingerprint(a));
});

test('WebDAV 与 S3 不会撞车（类型前缀不同）', () => {
  const webdav = createDestination('webdav', { baseUrl: 'https://x.example.com', remotePath: '/nw' });
  const s3 = createDestination('s3', { endpoint: 'https://x.example.com', bucket: 'nw' });

  assert.notEqual(getBackupDestinationAccessFingerprint(s3), getBackupDestinationAccessFingerprint(webdav));
});

// ── 保存后「要不要作废远端目录缓存」 ────────────────────────────────────────
// 保存逻辑原先**无条件**清缓存，于是「只改名字」也会把用户正看着的文件列表清空，
// 而刷新 effect 的指纹依赖没变、不会重载 ⇒ 列表一直空着，只能手动点「刷新」。

test('只改名字 / 调度：不作废缓存（列表该原样留着）', () => {
  const before = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'alice' });
  const after: BackupDestinationRecord = {
    ...before,
    name: '我的备份',
    schedule: { ...before.schedule, intervalHours: 24, retentionCount: 5 },
    runtime: { ...before.runtime, lastSuccessAt: '2026-09-20T03:00:12.000Z' },
  };

  assert.equal(shouldInvalidateRemoteBrowserCache(before, after), false, '改名不该把列表清掉');
});

test('改地址 / 账号 / 远端目录：必须作废缓存', () => {
  const before = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'alice' });

  const otherUrl = createDestination('webdav', { baseUrl: 'https://dav.example.com/other', username: 'alice' });
  const otherUser = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'bob' });
  const otherPath = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', username: 'alice', remotePath: '/other' });

  assert.equal(shouldInvalidateRemoteBrowserCache(before, otherUrl), true, '旧列表是按旧地址拉的，不可信');
  assert.equal(shouldInvalidateRemoteBrowserCache(before, otherUser), true);
  assert.equal(shouldInvalidateRemoteBrowserCache(before, otherPath), true);
});

test('从「尚未配置」变成「已配置」：作废缓存（本次要修的主场景）', () => {
  const empty = createDestination('webdav');
  const filled = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup' });

  assert.equal(shouldInvalidateRemoteBrowserCache(empty, filled), true);
});

test('只改密码：不作废缓存（指纹刻意不含密钥，属已知行为）', () => {
  const before = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', password: 'wrong-secret' });
  const after = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup', password: 'right-secret' });

  assert.equal(shouldInvalidateRemoteBrowserCache(before, after), false);
});

test('目标记录消失（被删）：作废缓存，别留残留键', () => {
  const before = createDestination('webdav', { baseUrl: 'https://dav.example.com/backup' });

  assert.equal(shouldInvalidateRemoteBrowserCache(before, null), true);
  assert.equal(shouldInvalidateRemoteBrowserCache(before, undefined), true);
  assert.equal(shouldInvalidateRemoteBrowserCache(null, null), true, '拿不到记录时宁可多清一次');
});

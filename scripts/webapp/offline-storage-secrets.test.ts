// 「敏感数据落盘」这条链路的断言（CodeQL js/clear-text-storage-of-sensitive-data ×5）。
//
// 背景：CodeQL 报了 5 条 high —— localStorage 里被写入了"来自登录流程/profile 的敏感数据"。
// 逐个核实后的结论是「设计如此 + 误报」：
//   · 会话只存 `{ email, authMode }`，**不存** access/refresh token（历史版本存过，`loadSession`
//     里专门有一段迁移逻辑把它们清掉）；
//   · profile 快照走 `stripProfileSecrets` 白名单，`key` 置空、`privateKey` 置 null；
//   · 离线解锁必须存一份"加密后的用户密钥"（EncString）与 KDF 迭代数 —— 否则断开网络就无法解锁。
// 但"核实过"不等于"以后不会退化"，所以把三条结论写成断言：
//   **任何写进 localStorage 的内容都不得出现这些明文标记**。
//
// 注意：Node 里没有可靠的 localStorage（版本差异大），因此这里注入一个内存桩，
// 既避免依赖运行时行为，也顺便能读到"到底写了什么"。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { saveProfileSnapshot, saveSession, stripProfileSecrets } from '../../webapp/src/lib/api/auth';
import { saveOfflineUnlockRecord } from '../../webapp/src/lib/offline-auth';
import type { Profile } from '../../webapp/src/lib/types';

const EMAIL = 'user@example.test';

// 这些标记代表"绝不能落盘"的东西：令牌、明文/包裹密钥、master password hash
const MARKERS = {
  accessToken: 'ACCESS-TOKEN-MARKER',
  refreshToken: 'REFRESH-TOKEN-MARKER',
  symEncKey: 'SYM-ENC-KEY-MARKER',
  symMacKey: 'SYM-MAC-KEY-MARKER',
  wrappedKey: 'WRAPPED-USER-KEY-MARKER',
  privateKey: 'PRIVATE-KEY-MARKER',
  masterHash: 'MASTER-PASSWORD-HASH-MARKER',
};

function installLocalStorageStub(): { entries: () => Array<[string, string]>; restore: () => void } {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stub = {
    getItem: (key: string): string | null => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string): void => void store.set(key, String(value)),
    removeItem: (key: string): void => void store.delete(key),
    clear: (): void => store.clear(),
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    get length(): number {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  return {
    entries: () => Array.from(store.entries()),
    restore: () => {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

/** 只看内容，不管键名：键名属实现细节，泄漏与否取决于"写了什么" */
function storedText(entries: Array<[string, string]>): string {
  return entries.map(([, value]) => value).join('\n');
}

function assertNoMarkers(entries: Array<[string, string]>, context: string): void {
  const text = storedText(entries);
  for (const [name, marker] of Object.entries(MARKERS)) {
    assert.doesNotMatch(text, new RegExp(marker), `${context}：落盘内容里出现了 ${name} 的明文标记`);
  }
}

function fullProfile(): Profile {
  return {
    id: 'user-1',
    email: EMAIL,
    name: 'Example User',
    role: 'admin',
    key: MARKERS.wrappedKey,
    privateKey: MARKERS.privateKey,
    publicKey: 'PUBLIC-KEY',
    masterPasswordHint: 'hint',
    masterPasswordHash: MARKERS.masterHash,
  };
}

test('会话落盘只保留 email + authMode，绝不写 access/refresh token', () => {
  const stub = installLocalStorageStub();
  try {
    saveSession({
      email: EMAIL,
      authMode: 'token',
      accessToken: MARKERS.accessToken,
      refreshToken: MARKERS.refreshToken,
      symEncKey: MARKERS.symEncKey,
      symMacKey: MARKERS.symMacKey,
    });

    const entries = stub.entries();
    assert.equal(entries.length, 1, '应当只写一个条目');
    assert.deepEqual(JSON.parse(entries[0][1]), { email: EMAIL, authMode: 'token' });
    assertNoMarkers(entries, 'saveSession');
  } finally {
    stub.restore();
  }
});

test('profile 快照必须剥掉密钥，且未知字段不落盘', () => {
  const stub = installLocalStorageStub();
  try {
    saveProfileSnapshot(fullProfile());

    const entries = stub.entries();
    assert.equal(entries.length, 1);
    const stored = JSON.parse(entries[0][1]) as Profile;
    assert.equal(stored.key, '', '包裹后的用户密钥不得落盘');
    assert.equal(stored.privateKey, null, '私钥不得落盘');
    assert.equal(stored.email, EMAIL, '其余展示字段必须保留');
    assert.equal(stored.role, 'admin');
    assert.equal(stored.masterPasswordHash, undefined, '未知字段（含 master hash）必须被丢弃');
    assertNoMarkers(entries, 'saveProfileSnapshot');

    // 白名单本身也直接断言一次，避免只有"经由 saveProfileSnapshot"才被覆盖
    const stripped = stripProfileSecrets(fullProfile())!;
    assert.equal(String(stripped.key), '');
    assert.equal(stripped.privateKey, null);
    assert.equal(stripped.masterPasswordHash, undefined);
  } finally {
    stub.restore();
  }
});

test('离线解锁记录只存加密后的密钥与 KDF 参数，profile 同样走白名单', () => {
  const stub = installLocalStorageStub();
  try {
    saveOfflineUnlockRecord({
      email: EMAIL.toUpperCase(),
      profile: fullProfile(),
      profileKey: '2.encrypted|user|key',
      kdfIterations: 600000,
    });

    const entries = stub.entries();
    assert.equal(entries.length, 1);
    const record = JSON.parse(entries[0][1]) as {
      version: number;
      email: string;
      profile: Profile;
      profileKey: string;
      kdfIterations: number;
      savedAt: number;
    };
    assert.equal(record.version, 1);
    assert.equal(record.email, EMAIL, 'email 必须规范化为小写');
    assert.equal(record.profileKey, '2.encrypted|user|key', '这里存的必须是加密后的密钥（EncString）');
    assert.equal(record.kdfIterations, 600000);
    assert.equal(record.profile.key, '', '离线 profile 里的密钥同样要清空');
    assert.equal(record.profile.privateKey, null);
    assert.equal(record.profile.masterPasswordHash, undefined, '未知字段必须被丢弃');
    assertNoMarkers(entries, 'saveOfflineUnlockRecord');
  } finally {
    stub.restore();
  }
});

test('离线解锁记录：缺少加密密钥或 KDF 参数时一律不落盘', () => {
  const stub = installLocalStorageStub();
  try {
    saveOfflineUnlockRecord({ email: EMAIL, profile: fullProfile(), profileKey: '', kdfIterations: 600000 });
    saveOfflineUnlockRecord({ email: EMAIL, profile: fullProfile(), profileKey: '2.a|b|c', kdfIterations: 0 });
    assert.equal(stub.entries().length, 0, '参数不完整时不应写入任何内容');
  } finally {
    stub.restore();
  }
});

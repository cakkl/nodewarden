// 机密管理器的加密工具：线格式必须与官方 EncString type 2 一致。
//
// **不用被测代码自证**：① 派生参数钉在官方仓库的固定向量上（`fake-server` 与
// `bootstrap.sh` 里的公开测试数据，官方 `bws` 真机解开过）；② 再用 `node:crypto` 独立实现
// HMAC-SHA256 / HKDF-Expand 交叉验证（RFC 2104 / RFC 5869）。
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { base64ToBytes, bytesToBase64 } from '../../webapp/src/lib/crypto';
import {
  accessTokenKeyPair,
  decodeAccessTokenPayload,
  decryptField,
  deriveAccessTokenKey,
  encodeAccessTokenPayload,
  encryptField,
  splitKeyPair,
  unwrapOrgKey,
  wrapOrgKey,
} from '../../webapp/src/lib/secrets-crypto';

/** 令牌携带的密钥材料：固定值 ⇒ 派生结果可钉住。 */
const KEY_MATERIAL = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const ORG_KEY = Uint8Array.from({ length: 64 }, (_, index) => 200 - index);

/** 官方 fake-server 的固定访问令牌，以及登录响应里的 `encrypted_payload`。 */
const FAKE_ACCESS_TOKEN =
  '0.ec2c1d46-6a4b-4751-a310-af9601317f2d.C2IgxjjLF7qSshsbwe8JGcbM075YXw:X8vbvA0bduihIDe/qrzIQQ==';
const FAKE_ENCRYPTED_PAYLOAD =
  '2.E9fE8+M/VWMfhhim1KlCbQ==|eLsHR484S/tJbIkM6spnG/HP65tj9A6Tba7kAAvUp+rYuQmGLixiOCfMsqt5OvBctDfvvr/AesBu7cZimPLyOEhqEAjn52jF0eaI38XZfeOG2VJl0LOf60Wkfh3ryAMvfvLj3G4ZCNYU8sNgoC2+IQ==|lNApuCQ4Pyakfo/wwuuajWNaEX/2MW8/3rjXB/V7n+k=';

/** 解开 `encrypted_payload` 得到的组织密钥（64 字节）；下面的机密就是用它加密的。 */
const FAKE_ORG_KEY = 'k/6PcwG7Hm/eZfvvOvP6EqGx1JKgbzYrWwpOIHsxbJHQMpIMg5Ud94AQHduSR+XMMaFiSB+nszbO4JPXj04YwA==';
const FAKE_SECRET_KEY =
  '2.WYqmVCB2wZc08tkzNOCmTw==|FAsVol/nJnnDk3/mp7z6QQ==|uPJOCC8iAbMzz4t60c35iZm8KzWKMn0ueCVJZlfmTdY=';

/** RFC 5869 §2.3 的 HKDF-Expand（独立实现，刻意不复用被测模块）。 */
function rfc5869Expand(prk: Uint8Array, info: string, length: number): Uint8Array {
  const infoBytes = Buffer.from(info, 'utf8');
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  const blockCount = Math.ceil(length / 32);
  for (let counter = 1; counter <= blockCount; counter += 1) {
    previous = createHmac('sha256', Buffer.from(prk))
      .update(previous)
      .update(infoBytes)
      .update(Buffer.from([counter]))
      .digest();
    blocks.push(previous);
  }
  return new Uint8Array(Buffer.concat(blocks).subarray(0, length));
}

test('令牌派生 = HMAC-SHA256("bitwarden-accesstoken") + HKDF-Expand("sm-access-token", 64)', async () => {
  const actual = await deriveAccessTokenKey(KEY_MATERIAL);
  const prk = new Uint8Array(createHmac('sha256', 'bitwarden-accesstoken').update(KEY_MATERIAL).digest());
  assert.deepEqual(actual, rfc5869Expand(prk, 'sm-access-token', 64), 'HMAC 名 / info / 长度 任一处不一致都会失败');
});

test('官方固定向量：令牌 → encrypted_payload → 组织密钥 → 机密（`bws` 真机解开过的同一组值）', async () => {
  const material = base64ToBytes(FAKE_ACCESS_TOKEN.slice(FAKE_ACCESS_TOKEN.indexOf(':') + 1));
  const orgKey = await decodeAccessTokenPayload(FAKE_ENCRYPTED_PAYLOAD, await accessTokenKeyPair(material));

  assert.equal(bytesToBase64(orgKey), FAKE_ORG_KEY, '派生或载荷形状错一步，这里就会 MAC mismatch');
  assert.equal(orgKey.length, 64);
  assert.equal(await decryptField(FAKE_SECRET_KEY, splitKeyPair(orgKey)), 'btw');
});

test('组织密钥是 64 字节直切（不做 HKDF 拉伸），长度不对必须报错', () => {
  const key = Uint8Array.from({ length: 64 }, (_, index) => index);
  const { encKey, macKey } = splitKeyPair(key);
  assert.deepEqual(encKey, key.slice(0, 32));
  assert.deepEqual(macKey, key.slice(32));
  assert.throws(() => splitKeyPair(new Uint8Array(32)), /64 bytes/);
});

test('字段加解密：线格式是 `2.<iv>|<ct>|<mac>`，往返可用，改一个字符就解不开', async () => {
  const orgKey = await accessTokenKeyPair(KEY_MATERIAL);
  const cipher = await encryptField('postgres://demo', orgKey);

  assert.match(cipher, /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/, '必须是 EncString type 2');
  assert.equal(await decryptField(cipher, orgKey), 'postgres://demo');

  const tampered = `${cipher.slice(0, -1)}${cipher.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(() => decryptField(tampered, orgKey), 'MAC 不符必须抛错，不能返回垃圾');
});

test('组织密钥：能被自己的用户密钥解开，换一把就解不开', async () => {
  const userKey = await accessTokenKeyPair(Uint8Array.from({ length: 32 }, (_, index) => index));
  const otherUserKey = await accessTokenKeyPair(Uint8Array.from({ length: 32 }, (_, index) => index + 99));

  const wrapped = await wrapOrgKey(ORG_KEY, userKey);
  assert.deepEqual(await unwrapOrgKey(wrapped, userKey), ORG_KEY);
  await assert.rejects(() => unwrapOrgKey(wrapped, otherUserKey));

  const payload = await encodeAccessTokenPayload(ORG_KEY, userKey);
  assert.deepEqual(await decodeAccessTokenPayload(payload, userKey), ORG_KEY);
  await assert.rejects(() => decodeAccessTokenPayload(payload, otherUserKey));
});

test('令牌载荷可由「重新派生同一把密钥」的另一侧解开（CLI 取用路径可复现）', async () => {
  const payload = await encodeAccessTokenPayload(ORG_KEY, await accessTokenKeyPair(KEY_MATERIAL));
  // 模拟程序侧：只拿到令牌里的密钥材料，重新派生后再解 payload
  const rederived = await accessTokenKeyPair(KEY_MATERIAL);
  assert.deepEqual(await decodeAccessTokenPayload(payload, rederived), ORG_KEY);
});

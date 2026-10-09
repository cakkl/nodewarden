import { base64ToBytes, bytesToBase64, decryptBw, decryptStr, encryptBw, hmacSha256, hkdfExpand, requireWebCrypto } from './crypto';

/**
 * 机密管理器的加密工具：**线格式与官方 EncString type 2 对齐** —— 同一份密文要能被 Web 端与
 * `bws` / 官方 SDK 互相解开。原语复用 `./crypto`，本文件只管两件事：密钥怎么派生、字段怎么包。
 */

/**
 * 令牌密钥材料的派生域 —— **与官方 `derive_shareable_key` 逐字一致**。
 *
 * `accesstoken` 是 HMAC 密钥里的名字（`bitwarden-accesstoken`），`sm-access-token` 才是
 * HKDF-Expand 的 info。把两者用反、或漏掉 HMAC 那一步，`bws` 登录时就会报解不开
 * `encrypted_payload`。
 */
const ACCESS_TOKEN_KEY_NAME = 'accesstoken';
const ACCESS_TOKEN_KEY_INFO = 'sm-access-token';

/** 对称密钥（组织密钥、令牌密钥）固定 64 字节：`enc(32) ‖ mac(32)`。 */
export const SYMMETRIC_KEY_BYTES = 64;

/** 对称密钥的 enc / mac 形态（与登录会话里的 `symEncKey` / `symMacKey` 同形）。 */
export interface SmKeyPair {
  encKey: Uint8Array;
  macKey: Uint8Array;
}

const encoder = new TextEncoder();

/** 令牌携带的原始密钥材料（16 字节）→ 64 字节访问令牌密钥。 */
export async function deriveAccessTokenKey(keyMaterial: Uint8Array): Promise<Uint8Array> {
  const prk = await hmacSha256(encoder.encode(`bitwarden-${ACCESS_TOKEN_KEY_NAME}`), keyMaterial);
  return hkdfExpand(prk, ACCESS_TOKEN_KEY_INFO, SYMMETRIC_KEY_BYTES);
}

/**
 * 64 字节对称密钥 → enc / mac 两半。
 *
 * 官方这一步是**直切**（前 32 = enc，后 32 = mac），没有 HKDF 拉伸 —— 密钥自带 mac 半。
 */
export function splitKeyPair(symmetricKey: Uint8Array): SmKeyPair {
  if (symmetricKey.byteLength !== SYMMETRIC_KEY_BYTES) {
    throw new Error(`Symmetric key must be ${SYMMETRIC_KEY_BYTES} bytes`);
  }
  return { encKey: symmetricKey.slice(0, 32), macKey: symmetricKey.slice(32) };
}

/** 由令牌密钥材料一步得到可用的 enc / mac（= 上面两步的组合）。 */
export async function accessTokenKeyPair(keyMaterial: Uint8Array): Promise<SmKeyPair> {
  return splitKeyPair(await deriveAccessTokenKey(keyMaterial));
}

/** 加密一个字段。key / value / note 共用同一把组织密钥（官方没有每密文 DEK，别加一层）。 */
export async function encryptField(plain: string, key: SmKeyPair): Promise<string> {
  return encryptBw(encoder.encode(plain), key.encKey, key.macKey);
}

/** 解密一个字段。type 2 带 MAC 校验 ⇒ 密钥不对或密文被改都会抛错，不会返回垃圾。 */
export async function decryptField(cipher: string, key: SmKeyPair): Promise<string> {
  return decryptStr(cipher, key.encKey, key.macKey);
}

/** 组织密钥的用户侧包裹（存 `sm_org_keys.wrapped_org_key`）。 */
export async function wrapOrgKey(orgKey: Uint8Array, userKey: SmKeyPair): Promise<string> {
  return encryptBw(orgKey, userKey.encKey, userKey.macKey);
}

/** 解出组织密钥；用户密钥不对会抛错（MAC 校验）。 */
export async function unwrapOrgKey(wrapped: string, userKey: SmKeyPair): Promise<Uint8Array> {
  return decryptBw(wrapped, userKey.encKey, userKey.macKey);
}

/** 令牌 `encrypted_payload` 的载荷：组织密钥以 base64 放在这里。 */
interface AccessTokenPayload {
  encryptionKey: string;
}

/** 把 64 字节组织密钥包成 `encrypted_payload`（创建令牌时调用）。 */
export async function encodeAccessTokenPayload(orgKey: Uint8Array, tokenKey: SmKeyPair): Promise<string> {
  const payload: AccessTokenPayload = { encryptionKey: bytesToBase64(orgKey) };
  return encryptBw(encoder.encode(JSON.stringify(payload)), tokenKey.encKey, tokenKey.macKey);
}

/**
 * 用令牌密钥解开 `encrypted_payload`，得到组织密钥（64 字节）。
 *
 * 载荷形状与上面的派生都由官方固定向量钉住（见 `scripts/webapp/secrets-crypto.test.ts`）。
 */
export async function decodeAccessTokenPayload(encryptedPayload: string, tokenKey: SmKeyPair): Promise<Uint8Array> {
  const parsed = JSON.parse(await decryptStr(encryptedPayload, tokenKey.encKey, tokenKey.macKey)) as Partial<AccessTokenPayload>;
  if (typeof parsed.encryptionKey !== 'string' || !parsed.encryptionKey) {
    throw new Error('SM access token payload is missing encryptionKey');
  }
  return base64ToBytes(parsed.encryptionKey);
}

/**
 * 访问令牌的明文密钥：**服务端从没见过它**，只收到它的哈希。
 * ⚠️ 长度与后端 `LIMITS.auth.clientSecretLength` 对齐（30）。
 */
const TOKEN_SECRET_LENGTH = 30;
const TOKEN_SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateTokenSecret(): string {
  const bytes = requireWebCrypto().getRandomValues(new Uint8Array(TOKEN_SECRET_LENGTH));
  let out = '';
  for (const byte of bytes) out += TOKEN_SECRET_ALPHABET[byte % TOKEN_SECRET_ALPHABET.length];
  return out;
}

/** 明文令牌里 `:` 之后的密钥材料（16 字节）。 */
export function generateTokenKeyMaterial(): Uint8Array {
  return requireWebCrypto().getRandomValues(new Uint8Array(16));
}

/**
 * `sha256:<64 位小写 hex>` —— **必须与后端 `hashApiKey` 逐字一致**（它按 `SECRET_HASH_PATTERN`
 * 校验），否则令牌永远登不上。
 */
export async function hashTokenSecret(secret: string): Promise<string> {
  const digest = new Uint8Array(await requireWebCrypto().subtle.digest('SHA-256', encoder.encode(secret)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

/** 拼装给 `bws` / 官方 SDK 的明文令牌：`0.<id>.<密钥>:<base64(密钥材料)>`。**只显示一次**。 */
export function formatAccessToken(tokenId: string, secret: string, keyMaterial: Uint8Array): string {
  return `0.${tokenId}.${secret}:${bytesToBase64(keyMaterial)}`;
}

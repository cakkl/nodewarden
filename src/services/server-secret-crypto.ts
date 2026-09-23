/**
 * 服务器侧「域密钥」加密原语。
 *
 * 用途：把管理员录入的第三方凭据加密后落库 —— `config` 表会随备份导出，
 * 凭据不能以明文进 config。
 *
 * 每个调用方用**自己的** HKDF salt/info（域分离）。
 * ⚠️ 换 salt 会让旧密文无法解开。
 */

const AES_GCM_ALGORITHM = 'AES-GCM';
const AES_GCM_IV_BYTES = 12;
const AES_GCM_KEY_BITS = 256;

export interface DomainSecretEnvelope {
  iv: string;
  ciphertext: string;
}

/** 二进制 → base64（分块，避免大数组爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(String(value || '').trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 由服务器主密钥经 HKDF-SHA256 派生出某个功能域的 AES-GCM 密钥。
 * 用 HKDF 而不是直接用 `JWT_SECRET`：归一长度，且 salt/info 让不同功能得到互不相关的密钥。
 */
export async function deriveServerDomainKey(secret: string, salt: string, info: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(salt), info: encoder.encode(info) },
    keyMaterial,
    AES_GCM_KEY_BITS
  );
  return crypto.subtle.importKey('raw', bits, { name: AES_GCM_ALGORITHM }, false, ['encrypt', 'decrypt']);
}

export async function encryptDomainValue(plaintext: string, key: CryptoKey): Promise<DomainSecretEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: AES_GCM_ALGORITHM, iv }, key, new TextEncoder().encode(plaintext))
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
}

export async function decryptDomainValue(
  envelope: DomainSecretEnvelope,
  key: CryptoKey
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: AES_GCM_ALGORITHM, iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

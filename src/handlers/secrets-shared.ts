/**
 * 机密管理器端点的公共校验。单独成模块，是为了让 `secrets.ts`（组织与组织密钥）与
 * `secrets-machine.ts`（机器账号与令牌）共用**同一份**判定，而不是各写一个正则。
 */

/**
 * EncString type 2：`2.<b64 iv>|<b64 ct>|<b64 mac>`。
 *
 * ⚠️ 只查 base64 形状**不够**：一条 MAC 长度不对的记录能让官方客户端**整个列表**读不出来
 * （`Invalid length: expected 32, got 16`），所以长度也要钉住。
 */
const ENC_STRING_PATTERN = /^2\.([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)$/;

/** 合法的 type 2 恒为：iv 16 字节、mac 32 字节、ct 是 16 字节的整数倍（PKCS#7 填充）。 */
const ENC_IV_BYTES = 16;
const ENC_MAC_BYTES = 32;
const AES_BLOCK_BYTES = 16;

/** base64 → 解码后字节数；形状非法（含长度不是 4 的倍数）返回 -1。 */
function decodedByteLength(base64: string): number {
  if (base64.length % 4 !== 0) return -1;
  try {
    return atob(base64).length;
  } catch {
    return -1;
  }
}

/** `secret_hash` 的形状：`sha256:<64 位小写十六进制>`（与 `hashApiKey` / `verifyApiKey` 一致）。 */
const SECRET_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 是否是形状与长度都合法的 EncString type 2；`maxLength` 用于顺带挡住超大字符串。 */
export function isEncString(value: unknown, maxLength = 8192): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  const parts = ENC_STRING_PATTERN.exec(value);
  if (!parts) return false;

  const iv = decodedByteLength(parts[1]);
  const ciphertext = decodedByteLength(parts[2]);
  const mac = decodedByteLength(parts[3]);
  return (
    iv === ENC_IV_BYTES &&
    mac === ENC_MAC_BYTES &&
    ciphertext >= AES_BLOCK_BYTES &&
    ciphertext % AES_BLOCK_BYTES === 0
  );
}

/**
 * 是否是客户端算好的 `SHA-256(client_secret)`。
 *
 * ⚠️ 明文密钥**不进服务端**：客户端自己算哈希，服务端只存这个值。因此这里的形状校验是
 * 必须的 —— 存进一个不合格式的值，会让 `verifyApiKey` 永远比对失败（即令牌永远登不上）。
 */
export function isSecretHash(value: unknown): value is string {
  return typeof value === 'string' && SECRET_HASH_PATTERN.test(value);
}

/** 非空且不过长的显示名（机器账号名、令牌名）。 */
export function normalizeName(value: unknown, maxLength = 120): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= maxLength ? name : null;
}

/** 可选的 RFC3339 时间：缺省返回 `null`；给了但解析不出来返回 `undefined`（调用方据此报 400）。 */
export function normalizeOptionalTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

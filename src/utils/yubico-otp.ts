import type { Env, User } from '../types';
import { isRequestTimeoutError, withRequestTimeout } from './request-timeout';

const YUBIKEY_PUBLIC_ID_LENGTH = 12;
const YUBIKEY_MIN_OTP_LENGTH = 32;
const YUBIKEY_MAX_OTP_LENGTH = 48;
const YUBICO_DEFAULT_VALIDATION_URL = 'https://api.yubico.com/wsapi/2.0/verify';
const YUBICO_GET_API_KEY_URL = 'https://upgrade.yubico.com/getapikey/';
const MODHEX_RE = /^[cbdefghijklnrtuv]+$/;

/**
 * 外发请求超时预算。
 *
 * Yubico 的两个端点都在交互路径上：一个是登录的二步验证，一个是管理员启用 YubiKey 时
 * 取 API 凭据。两处原先都没有超时 —— 对端「连上但不回包」时请求会一直挂着，
 * 最后由平台兜底返回通用 500：用户既登不进去，也看不到原因。
 */
const YUBICO_API_KEY_REQUEST_TIMEOUT_MS = 5_000;
const YUBICO_VALIDATION_REQUEST_TIMEOUT_MS = 5_000;

/** 仅供测试注入更小的超时，避免单测真的等 5 秒；生产代码不要传。 */
export interface YubicoRequestOptions {
  requestTimeoutMs?: number;
}

function resolveRequestTimeoutMs(override: number | undefined, fallback: number): number {
  return typeof override === 'number' && Number.isFinite(override) && override > 0
    ? Math.floor(override)
    : fallback;
}

/** 只取主机名：校验地址的查询串里含一次性口令，绝不能进日志。 */
function safeHostname(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'unknown-host';
  }
}

export interface YubicoApiCredentials {
  clientId: string;
  secretKey: string;
}

export function normalizeYubiKeyOtp(input: string): string {
  return String(input || '').replace(/\s+/g, '').toLowerCase();
}

export function yubiKeyPublicIdFromOtp(input: string): string | null {
  const otp = normalizeYubiKeyOtp(input);
  if (otp.length === YUBIKEY_PUBLIC_ID_LENGTH && MODHEX_RE.test(otp)) return otp;
  if (otp.length < YUBIKEY_MIN_OTP_LENGTH || otp.length > YUBIKEY_MAX_OTP_LENGTH) return null;
  if (!MODHEX_RE.test(otp)) return null;
  return otp.slice(0, YUBIKEY_PUBLIC_ID_LENGTH);
}

export function isYubiKeyPublicId(input: string): boolean {
  const value = normalizeYubiKeyOtp(input);
  return value.length === YUBIKEY_PUBLIC_ID_LENGTH && MODHEX_RE.test(value);
}

function isYubiKeyOtp(input: string): boolean {
  const otp = normalizeYubiKeyOtp(input);
  return otp.length >= YUBIKEY_MIN_OTP_LENGTH && otp.length <= YUBIKEY_MAX_OTP_LENGTH && MODHEX_RE.test(otp);
}

export function userYubiKeyPublicIds(user: User): string[] {
  return [
    user.yubikeyKey1,
    user.yubikeyKey2,
    user.yubikeyKey3,
    user.yubikeyKey4,
    user.yubikeyKey5,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
}

export function isYubiKeyEnabled(user: User): boolean {
  return userYubiKeyPublicIds(user).length > 0;
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseYubicoResponse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function bytesToBase64(input: Uint8Array): string {
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha1Base64(base64Key: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(base64Key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

function constantTimeStringEquals(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = aBytes.length ^ bBytes.length;
  for (let index = 0; index < aBytes.length && index < bBytes.length; index += 1) {
    diff |= aBytes[index] ^ bBytes[index];
  }
  return diff === 0;
}

function canonicalQuery(params: URLSearchParams): string {
  return Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function validationUrls(env: Env): string[] {
  const configured = String(env['globalSettings__yubico__validationUrls'] || env.YUBICO_VALIDATION_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [YUBICO_DEFAULT_VALIDATION_URL];
}

export async function requestYubicoApiCredentials(
  email: string,
  otpInput: string,
  options: YubicoRequestOptions = {}
): Promise<YubicoApiCredentials | null> {
  const otp = normalizeYubiKeyOtp(otpInput);
  if (!isYubiKeyOtp(otp)) return null;

  const body = new URLSearchParams();
  body.set('email', String(email || '').trim().toLowerCase());
  body.set('otp', otp);
  body.set('terms_conditions', 'consented');

  const timeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs, YUBICO_API_KEY_REQUEST_TIMEOUT_MS);
  try {
    const response = await withRequestTimeout(timeoutMs, (signal) =>
      fetch(YUBICO_GET_API_KEY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      })
    );
    if (!response.ok) return null;

    const html = await response.text();
    const clientId = /Client ID:<\/th>\s*<td><b>(\d+)<\/b>/i.exec(html)?.[1] || '';
    const secretKey = /Secret key:<\/th>\s*<td><code>([^<]+)<\/code>/i.exec(html)?.[1] || '';
    return clientId ? { clientId, secretKey } : null;
  } catch (error) {
    // 本函数的失败通道就是 `null`（调用方据此回 400「无法初始化 Yubico 校验凭据」）。
    // 不往外抛：抛出会让管理员看到平台兜底的通用 500，而不是那条可操作的提示。
    // 日志只记主机名与原因 —— 请求体里含一次性口令。
    // 不用模板串作 console 的首参（Semgrep unsafe-formatstring），动态值走结构化字段。
    console.error(
      isRequestTimeoutError(error) ? 'Yubico getapikey request timed out' : 'Yubico getapikey request failed',
      {
        host: safeHostname(YUBICO_GET_API_KEY_URL),
        timeoutMs,
        reason: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
}

export async function verifyYubicoOtp(
  env: Env,
  otpInput: string,
  credentials: YubicoApiCredentials | null,
  options: YubicoRequestOptions = {}
): Promise<boolean> {
  const otp = normalizeYubiKeyOtp(otpInput);
  if (!isYubiKeyOtp(otp)) return false;

  const clientId = String(credentials?.clientId || '').trim();
  const secretKey = String(credentials?.secretKey || '').trim();
  if (!clientId || !secretKey) return false;

  const nonce = randomNonce();
  const params = new URLSearchParams({
    id: clientId,
    nonce,
    otp,
  });
  try {
    params.set('h', await hmacSha1Base64(secretKey, canonicalQuery(params)));
  } catch {
    return false;
  }

  const timeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs, YUBICO_VALIDATION_REQUEST_TIMEOUT_MS);
  for (const baseUrl of validationUrls(env)) {
    try {
      const response = await withRequestTimeout(timeoutMs, (signal) =>
        fetch(`${baseUrl}?${params.toString()}`, { method: 'GET', signal })
      );
      if (!response.ok) continue;
      const parsed = parseYubicoResponse(await response.text());
      if (parsed.otp !== otp || parsed.nonce !== nonce || parsed.status !== 'OK') continue;
      if (!parsed.h) continue;
      const signedParams = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== 'h') signedParams.set(key, value);
      }
      if (!constantTimeStringEquals(await hmacSha1Base64(secretKey, canonicalQuery(signedParams)), parsed.h)) continue;
      return true;
    } catch (error) {
      // 超时与网络错误都落在这里：**保持 fail-closed**（继续试下一个校验地址，最终返回 false），
      // 并把原因记进日志 —— 只记主机名，URL 的查询串里含一次性口令。
      console.error('Yubico validation request failed', {
        host: safeHostname(baseUrl),
        timedOut: isRequestTimeoutError(error),
      });
      continue;
    }
  }

  return false;
}

import type { Env } from '../types';

// Keep this list aligned with Bitwarden server's default FIDO2 origins.
// These are the stable store IDs for the official Chromium-based extensions.
export const OFFICIAL_BITWARDEN_BROWSER_EXTENSION_ORIGINS = [
  'chrome-extension://nngceckbapebfimnlniiiahkandclblb',
  'chrome-extension://jbkfoedolllekgbhcbcoahefnbanhhlh',
  'chrome-extension://ccnckbpmaceehanjmeomladnmlffdjgn',
] as const;

// Bitwarden desktop is migrating from file:// to this privileged Electron
// origin. Official clients keep the legacy file:// path as a compatibility
// fallback while self-hosted servers add CORS support for the new origin.
export const OFFICIAL_BITWARDEN_DESKTOP_ORIGINS = [
  'bw-desktop-file://bundle',
] as const;

export function normalizeOrigin(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!url.protocol || !url.host) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * 写请求的同源判定（CSRF 防护）。
 *
 * `allowUnknownClient=true`（宽松）时**两个头都没带就放行** —— 那是原生客户端（不带
 * `Origin`/`Referer`）。这不削弱防护：浏览器发**跨源** POST 必带 `Origin`，CSRF 仍被拦。
 * 默认（严格）则拒绝，用于**有意只服务自家前端**的端点。
 */
export function isSameOriginWriteRequest(request: Request, allowUnknownClient = false): boolean {
  const targetOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin) return origin === targetOrigin;

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin === targetOrigin;
    } catch {
      return false;
    }
  }

  return allowUnknownClient;
}

export function isBrowserExtensionOrigin(origin: unknown): boolean {
  const normalized = normalizeOrigin(origin);
  return !!normalized && (
    normalized.startsWith('chrome-extension://')
    || normalized.startsWith('moz-extension://')
    || normalized.startsWith('safari-web-extension://')
  );
}

export function isOfficialBitwardenDesktopOrigin(origin: unknown): boolean {
  const normalized = normalizeOrigin(origin);
  return !!normalized && OFFICIAL_BITWARDEN_DESKTOP_ORIGINS.includes(
    normalized as (typeof OFFICIAL_BITWARDEN_DESKTOP_ORIGINS)[number]
  );
}

export function getConfiguredWebAuthnAllowedOrigins(
  env: Pick<Env, 'WEBAUTHN_ALLOWED_ORIGINS'>
): string[] {
  const seen = new Set<string>([
    ...OFFICIAL_BITWARDEN_BROWSER_EXTENSION_ORIGINS,
    ...OFFICIAL_BITWARDEN_DESKTOP_ORIGINS,
  ]);
  for (const item of String(env.WEBAUTHN_ALLOWED_ORIGINS || '').split(',')) {
    const origin = normalizeOrigin(item);
    if (origin) seen.add(origin);
  }
  return Array.from(seen);
}

export function isConfiguredWebAuthnAllowedOrigin(
  env: Pick<Env, 'WEBAUTHN_ALLOWED_ORIGINS'>,
  origin: unknown
): boolean {
  const normalized = normalizeOrigin(origin);
  return !!normalized && getConfiguredWebAuthnAllowedOrigins(env).includes(normalized);
}

import { REDACTED_VALUE } from '@reticlehq/core';
import { isSensitiveKey } from '../security/serialization.js';

/** The three readable client-side storage areas. httpOnly cookies are invisible to JS by design. */
export interface StorageSnapshot {
  local: Record<string, string>;
  session: Record<string, string>;
  cookies: Record<string, string>;
}

/** Accessing localStorage/sessionStorage throws in a sandboxed iframe / disabled-storage context. */
function safeArea(get: () => Storage): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function readArea(storage: Storage | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (storage === null) return out;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null) continue;
    // Redact credential-bearing keys (token/session/password/…) so auth state never leaks verbatim.
    out[key] = isSensitiveKey(key) ? REDACTED_VALUE : (storage.getItem(key) ?? '');
  }
  return out;
}

function readCookies(): Record<string, string> {
  const out: Record<string, string> = {};
  // Reading document.cookie can throw (SecurityError) in a sandboxed / cookie-disabled context — guard
  // it the same way safeArea guards localStorage, so one bad area never crashes the whole STORAGE read.
  let raw = '';
  try {
    raw = typeof document !== 'undefined' ? document.cookie : '';
  } catch {
    return out;
  }
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === '') continue;
    if (isSensitiveKey(key)) {
      out[key] = REDACTED_VALUE;
      continue;
    }
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Read client-side storage on demand (the STORAGE_READ command). Powers `reticle_storage` — the
 * agent verifies "token persisted after login", "cart survived reload", "logout cleared the session"
 * from the app's real storage rather than inferring it from the DOM. `area` scopes to one area; omit
 * for all three. Sensitive keys are redacted; httpOnly cookies are unreadable by design (documented).
 */
export function readStorage(area?: string): StorageSnapshot | Record<string, string> {
  if (area === 'local') return readArea(safeArea(() => window.localStorage));
  if (area === 'session') return readArea(safeArea(() => window.sessionStorage));
  if (area === 'cookies') return readCookies();
  return {
    local: readArea(safeArea(() => window.localStorage)),
    session: readArea(safeArea(() => window.sessionStorage)),
    cookies: readCookies(),
  };
}

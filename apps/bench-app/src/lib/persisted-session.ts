/**
 * Sign-in persistence for the benchmark fixture.
 *
 * This exists so the storage bug category has something true to be wrong about. Until now the
 * app kept auth purely in memory, so every "the token is persisted" assertion would have failed on a
 * CLEAN build — the bugs would have been false positives rather than bugs.
 *
 * Deliberately written against the raw Storage / cookie APIs rather than a wrapper, because that is
 * the seam the injector patches: a real persistence bug is a write that silently does not land, goes
 * to the wrong store, or uses a pre-rename key — not a missing function call.
 */

/** Survives a tab close — this is what "remember me" means, and what a reload reads back. */
export const AUTH_TOKEN_KEY = 'reticle.bench.authToken';
/** Deliberately session-scoped: a session id that outlives the tab is the `session-in-localstorage` bug. */
export const SESSION_ID_KEY = 'reticle.bench.sessionId';
/** The server-visible half; a client that drops it looks signed in until the next API call. */
const SESSION_COOKIE = 'bench_session';

interface PersistedSession {
  token: string;
  sessionId: string;
}

/**
 * Mint ids without reaching for a clock inside logic — the caller owns any determinism it needs.
 *
 * `crypto.randomUUID` is missing in some browser builds (and in any non-secure context). It threw here
 * AFTER the store had already been updated, so the UI showed a signed-in user while nothing was
 * persisted and the error vanished into the React event handler — indistinguishable from the
 * `token-not-persisted` bug, on a clean build. Fall back rather than let sign-in half-succeed.
 */
function randomId(): string {
  if (typeof crypto !== 'undefined' && 'function' === typeof crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && 'function' === typeof crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSession(): PersistedSession {
  return { token: randomId(), sessionId: randomId() };
}

export function persistSession(session: PersistedSession): void {
  localStorage.setItem(AUTH_TOKEN_KEY, session.token);
  sessionStorage.setItem(SESSION_ID_KEY, session.sessionId);
  document.cookie = `${SESSION_COOKIE}=${session.sessionId}; path=/; SameSite=Lax`;
}

/** Sign-out must clear all three. Clearing only the UI is the `logout-leaves-token` bug. */
export function clearSession(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_ID_KEY);
  document.cookie = `${SESSION_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`;
}

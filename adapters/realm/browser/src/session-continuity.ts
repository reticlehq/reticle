/**
 * Keep a tab's session id across a reload.
 *
 * Minting the id fresh on every `connect()` is not enough: a reload is a new document, so the page
 * comes back as a NEW session while the agent still holds the previous id, and every call after
 * `reticle_navigate { reload: true }` is refused with "no browser session connected". A reload is the
 * most ordinary thing an agent does.
 *
 * `sessionStorage` is exactly the right scope: it survives reloads and same-tab navigations, and is
 * NOT shared with another tab of the same app — so two tabs stay two sessions, which is what the
 * multi-session tooling assumes.
 *
 * An explicit id still wins. `connect({ session })` and the `__reticle_session` URL param a lease
 * stamps are callers ASSERTING an identity, not asking for one; they are also remembered, so a
 * leased tab that reloads rejoins its own lease.
 */

import { ReticleStorageKey } from '@/storage-keys.js';

/** Where the id lives. Namespaced like the URL param it mirrors. */
const STORAGE_KEY = ReticleStorageKey.SESSION;

export function rememberSessionLabel(
  explicit: string | undefined,
  store: Storage | undefined,
  generate: () => string,
): string {
  const read = (): string | undefined => {
    try {
      const value = store?.getItem(STORAGE_KEY);
      return value !== null && value !== undefined && value.length > 0 ? value : undefined;
    } catch {
      return undefined; // a sandboxed iframe throws on access; a session must still start
    }
  };
  const write = (value: string): void => {
    try {
      store?.setItem(STORAGE_KEY, value);
    } catch {
      /* same: never block connect on storage */
    }
  };
  // `explicit` may be '' — resolveSessionLabel yields that for "none given" — and `??` would take it.
  const asked = explicit !== undefined && explicit.length > 0 ? explicit : undefined;
  const chosen = asked ?? read() ?? generate();
  write(chosen);
  return chosen;
}

/**
 * The store the tab's session id lives in, or undefined in a sub-frame.
 *
 * A same-origin iframe (an `about:srcdoc` preview, an embedded view of the same app) shares the
 * tab's `sessionStorage`. An SDK inside it read the top page's id, registered under it and replaced
 * the page's connection, so a lease went on to drive and grade the iframe (#2009). A sub-frame gets
 * no store and therefore an id of its own. A parent on another origin makes `top` throw; that is a
 * sub-frame too.
 */
export function tabSessionStore(win: Window & typeof globalThis): Storage | undefined {
  let topFrame: boolean;
  try {
    topFrame = win.top === win;
  } catch {
    topFrame = false;
  }
  if (!topFrame) {
    return undefined;
  }
  try {
    return win.sessionStorage;
  } catch {
    return undefined;
  }
}

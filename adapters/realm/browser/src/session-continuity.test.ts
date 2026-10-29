/**
 * A reload changed the session id, so every later call failed "no browser session connected".
 *
 * Reported on 6 of 6 apps, and reproduced here: `reticle_navigate { reload: true }` answers `ok`, the
 * page comes back and reconnects — as a NEW session. The agent is still holding the old id, and
 * every subsequent call is refused. A reload is the most ordinary thing an agent does.
 *
 *   before  : s722c8106-36d7-4a29-a9b7-0a6191b73a35
 *   reload  : { ok: true }
 *   +1500ms : ["sca257812-c863-4b55-a156-c537778bcdf8"]     <- different session
 *
 * The id was minted fresh on every `connect()`, and a reload is a new document, so it could not have
 * survived. But a reload is the SAME TAB, which is exactly what `sessionStorage` scopes to: it
 * survives reloads and navigations within the tab, and is not shared with another tab of the same
 * app. So the id persists there and a reloaded page rejoins its own session.
 *
 * An explicit id — from `connect({ session })` or the `__reticle_session` URL param a lease stamps —
 * still wins, because those callers are asserting an identity rather than asking for one.
 */

import { describe, expect, it } from 'vitest';
import { ReticleStorageKey } from '@/storage-keys.js';
import { rememberSessionLabel, tabSessionStore } from './session-continuity.js';

const STORAGE_KEY_FOR_TEST = ReticleStorageKey.SESSION;

/** A sessionStorage stand-in; the real one is per-tab and survives reloads. */
function fakeStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe('a session id that survives a reload', () => {
  it('reuses the id this tab already had', () => {
    const store = fakeStore({ __reticle_session: 's-existing' });
    expect(rememberSessionLabel(undefined, store, () => 's-new')).toBe('s-existing');
  });

  it('generates and REMEMBERS one on the first load', () => {
    const store = fakeStore();
    expect(rememberSessionLabel(undefined, store, () => 's-new')).toBe('s-new');
    // The whole point: the next load in this tab finds it.
    expect(rememberSessionLabel(undefined, store, () => 's-other')).toBe('s-new');
  });

  it('an EXPLICIT id always wins and is remembered, so a lease survives its own reload', () => {
    const store = fakeStore({ __reticle_session: 's-old' });
    expect(rememberSessionLabel('s-leased', store, () => 's-new')).toBe('s-leased');
    expect(rememberSessionLabel(undefined, store, () => 's-new')).toBe('s-leased');
  });

  it('still works when sessionStorage is unavailable', () => {
    // A sandboxed iframe throws on access. Degrading to the old per-load id is correct; throwing is not.
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    expect(rememberSessionLabel(undefined, hostile, () => 's-new')).toBe('s-new');
  });

  it('ignores a stored value that is empty', () => {
    expect(
      rememberSessionLabel(undefined, fakeStore({ __reticle_session: '' }), () => 's-new'),
    ).toBe('s-new');
  });

  it('treats an EMPTY explicit id as no id — the caller asserted nothing', () => {
    // resolveSessionLabel yields '' for "none given", and `??` would have accepted that as an id.
    const store = fakeStore({ __reticle_session: 's-existing' });
    expect(rememberSessionLabel('', store, () => 's-new')).toBe('s-existing');
  });
});

/**
 * A same-origin sub-frame shares the tab's `sessionStorage`. An SDK inside an `about:srcdoc` iframe
 * therefore read the top page's remembered id and registered under it, replacing the page's
 * connection: a lease then drove and graded the iframe (field report, 3.8.2; #2009).
 */
describe('tabSessionStore', () => {
  it('gives the top frame its sessionStorage', () => {
    const store = fakeStore();
    const win = { sessionStorage: store } as unknown as Window & typeof globalThis;
    (win as { top: unknown }).top = win;
    expect(tabSessionStore(win)).toBe(store);
  });

  it('gives a sub-frame no store, so it cannot take the tab id', () => {
    const store = fakeStore({ [STORAGE_KEY_FOR_TEST]: 's-top' });
    const win = { sessionStorage: store, top: {} } as unknown as Window & typeof globalThis;
    expect(tabSessionStore(win)).toBeUndefined();
    expect(rememberSessionLabel(undefined, tabSessionStore(win), () => 's-frame')).toBe('s-frame');
    expect(store.getItem(STORAGE_KEY_FOR_TEST)).toBe('s-top');
  });

  it('treats a cross-origin parent (top throws) as a sub-frame', () => {
    const win = {
      sessionStorage: fakeStore(),
      get top(): never {
        throw new Error('SecurityError');
      },
    } as unknown as Window & typeof globalThis;
    expect(tabSessionStore(win)).toBeUndefined();
  });
});

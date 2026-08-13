/**
 * A ref minted before a full navigation must never resolve after one.
 *
 * The stale-ref refusal was closed for SPA route changes and open for full navigations, which is the
 * more dangerous half. Refs are minted per DOCUMENT — a reload or a cross-page link tears the module
 * down and the next document starts minting from `e1` again — so `e7` from page A is a valid,
 * resolvable, DIFFERENT element on page B. Nothing refused: the wrong element was clicked and the
 * result reported `ok`. That is a false green we produce, which is the one category of defect this
 * product cannot ship.
 *
 * The fix does NOT change the wire format. Refs stay `e<n>` and the sequence simply never restarts:
 * each document reserves a block of numbers in `sessionStorage` before minting, so page B's `e7`
 * cannot exist. A stale ref then misses the map and the EXISTING refusal fires, already worded for
 * exactly this ("Reticle refuses here rather than clicking whatever now occupies that slot"). No new
 * ref grammar, no round-trip concern for the agents that pass refs back verbatim, and no migration
 * for the refs already sitting in saved flows on disk.
 *
 * `sessionStorage` is the right scope for the same reason session continuity uses it: it survives
 * reloads and same-tab navigations, and is not shared with another tab — where a second tab is a
 * second session with its own registry anyway.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RefRegistry, REF_BLOCK } from './refs.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A `sessionStorage` that outlives the document, which is the whole point of it. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const button = (): Element => {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
};

describe('refs across a full navigation', () => {
  it('never mints a ref the previous document already used', () => {
    const store = fakeStorage();
    const before = new RefRegistry(() => store);
    const minted = [button(), button(), button()].map((el) => before.refFor(el));

    // The document is torn down and rebuilt: a NEW registry, the SAME tab storage.
    document.body.innerHTML = '';
    const after = new RefRegistry(() => store);
    const fresh = [button(), button(), button()].map((el) => after.refFor(el));

    expect(fresh.filter((ref) => minted.includes(ref))).toEqual([]);
  });

  it('refuses a ref carried across the navigation instead of resolving it to another element', () => {
    const store = fakeStorage();
    const before = new RefRegistry(() => store);
    const stale = before.refFor(button());

    document.body.innerHTML = '';
    const after = new RefRegistry(() => store);
    // Page B mints plenty of its own elements — under the old scheme one of them WAS `stale`.
    for (let i = 0; i < 20; i += 1) after.refFor(button());

    expect(after.resolve(stale)).toBeNull();
  });

  it('keeps the plain `e<n>` wire format, so refs still round-trip verbatim', () => {
    const store = fakeStorage();
    new RefRegistry(() => store).refFor(button());
    const after = new RefRegistry(() => store);
    expect(after.refFor(button())).toMatch(/^e[1-9][0-9]*$/);
  });

  it('starts at e1 on the first document, so the common case stays short', () => {
    const registry = new RefRegistry(() => fakeStorage());
    expect(registry.refFor(button())).toBe('e1');
  });

  it('reserves before minting, so a document killed mid-flight still cannot be re-used', () => {
    // The reservation is written on the FIRST mint, not at unload — a page that crashes, is killed,
    // or navigates away with no unload event still leaves its block claimed.
    const store = fakeStorage();
    new RefRegistry(() => store).refFor(button());
    expect(Number(store.getItem('__reticle_ref_base'))).toBeGreaterThanOrEqual(REF_BLOCK);
  });

  it('claims another block rather than colliding when a page outmints its first one', () => {
    const store = fakeStorage();
    const busy = new RefRegistry(() => store);
    for (let i = 0; i < REF_BLOCK + 2; i += 1) busy.refFor(button());
    const next = new RefRegistry(() => store).refFor(button());
    expect(next).not.toBe('e1');
    expect(Number(next.slice(1))).toBeGreaterThan(REF_BLOCK);
  });

  it('still works when storage is unavailable, because a sandboxed iframe throws on access', () => {
    const hostile = (): Storage => {
      throw new Error('SecurityError');
    };
    const registry = new RefRegistry(hostile);
    const ref = registry.refFor(button());
    // No cross-document guarantee is possible without storage — but a session must still start, and
    // the SPA-side refusal (WeakRef liveness + isConnected) is unaffected.
    expect(registry.resolve(ref)).not.toBeNull();
  });

  it('ignores a corrupted reservation rather than minting NaN refs', () => {
    const store = fakeStorage();
    store.setItem('__reticle_ref_base', 'not-a-number');
    expect(new RefRegistry(() => store).refFor(button())).toMatch(/^e[1-9][0-9]*$/);
  });
});

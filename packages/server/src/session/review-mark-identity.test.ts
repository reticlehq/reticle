/**
 * A mark id must never come to mean a different mark.
 *
 * Reported by an agent that fixed two human-flagged bugs and then retired the wrong one. `review`
 * returned `m1` and `m2`; `resolve("m1")` answered `{"resolved":true}`, `resolve("m2")` answered
 * false, and a later listing showed a single mark `m1` carrying a note the human had recorded
 * MINUTES LATER. Misattribution in both directions at once: a fixed bug reported unresolved, an
 * untouched bug silently closed, and no way to undo either.
 *
 * The store's own sequence was fine — the STORE was not. It is created per Session, and a session
 * is recreated whenever the page reloads or the socket reattaches (that reporter's session
 * reattached repeatedly). Each new store restarted numbering at `m1`, so an id the agent was still
 * holding began denoting somebody else's mark.
 *
 * Two defences, because neither is sufficient alone:
 *
 *  - ids are minted from a counter that outlives any one store, so a reattach cannot reissue one;
 *  - `resolve` echoes back the note it retired, so a mismatch that survives anyway is DETECTABLE by
 *    the caller instead of silent. That was the reporter's own suggestion.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { MarkStatus, MarkAnchorStrategy } from '@reticlehq/core';
import { ReviewStore, resetMarkIdsForTest } from './review-store.js';

const mark = (note: string): Parameters<ReviewStore['add']>[0] => ({
  note,
  anchor: 'a',
  strategy: MarkAnchorStrategy.TESTID,
});

beforeEach(() => resetMarkIdsForTest());

describe('mark ids outlive the store that minted them', () => {
  it('does not reissue an id to a store created later', () => {
    const first = new ReviewStore();
    const a = first.add(mark('extension shows in rename'), 1);
    const b = first.add(mark('delete dialog does not close'), 2);

    // The page reloaded: a brand new Session, and with it a brand new store.
    const second = new ReviewStore();
    const later = second.add(mark('click to open shows blank'), 3);

    expect(new Set([a.id, b.id, later.id]).size).toBe(3);
    expect(later.id).not.toBe(a.id);
  });

  it('refuses a stale id rather than retiring whatever now sits in that slot', () => {
    const first = new ReviewStore();
    const stale = first.add(mark('the one I fixed'), 1).id;
    const second = new ReviewStore();
    second.add(mark('something the human said later'), 2);

    // The agent is still holding `stale` from before the reattach. It must not resolve anything.
    expect(second.resolve(stale)).toBe(false);
    expect(second.pending()).toHaveLength(1);
    expect(second.pending()[0]?.note).toBe('something the human said later');
  });

  it('still numbers marks predictably within one store', () => {
    const store = new ReviewStore();
    const a = store.add(mark('one'), 1);
    const b = store.add(mark('two'), 2);
    expect(a.id).not.toBe(b.id);
    expect(store.resolve(a.id)).toBe(true);
    expect(store.pending().map((m) => m.note)).toEqual(['two']);
  });
});

describe('resolve is verifiable', () => {
  it('reports WHICH mark it retired, so a mismatch can be caught', () => {
    const store = new ReviewStore();
    const target = store.add(mark('the delete dialog'), 1);
    store.add(mark('the rename field'), 2);
    expect(store.resolveDetail(target.id)).toEqual({
      resolved: true,
      id: target.id,
      note: 'the delete dialog',
    });
  });

  it('names nothing when it resolved nothing', () => {
    const store = new ReviewStore();
    expect(store.resolveDetail('m-nope')).toEqual({ resolved: false, id: 'm-nope' });
  });

  it('is idempotent, and says so without inventing a second resolution', () => {
    const store = new ReviewStore();
    const only = store.add(mark('once'), 1);
    expect(store.resolveDetail(only.id).resolved).toBe(true);
    expect(store.resolveDetail(only.id).resolved).toBe(false);
    expect(store.all()[0]?.status).toBe(MarkStatus.RESOLVED);
  });
});

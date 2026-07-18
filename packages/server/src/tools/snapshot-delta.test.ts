import { describe, expect, it } from 'vitest';
import {
  snapshotDelta,
  SnapshotCache,
  applySnapshotDelta,
  snapshotCacheKey,
  SnapshotDeltaMode,
} from './snapshot-delta.js';

const TREE_A = '- button "Save" (ref=e1)\n- button "Cancel" (ref=e2)';
const TREE_B = '- button "Save" (ref=e9)\n- button "Cancel" (ref=e2)\n- alert "Saved!" (ref=e3)';

describe('snapshotDelta (pure)', () => {
  it('returns full when there is no previous snapshot', () => {
    expect(snapshotDelta(undefined, TREE_A).mode).toBe(SnapshotDeltaMode.FULL);
  });

  it('returns unchanged when only ref ids differ (refs are normalized out)', () => {
    const refsOnlyChanged = '- button "Save" (ref=e7)\n- button "Cancel" (ref=e8)';
    expect(snapshotDelta(TREE_A, refsOnlyChanged).mode).toBe(SnapshotDeltaMode.UNCHANGED);
  });

  it('returns only the added/removed lines on a real change', () => {
    const d = snapshotDelta(TREE_A, TREE_B);
    if (d.mode !== SnapshotDeltaMode.DELTA) throw new Error('expected delta');
    expect(d.delta.added).toEqual(['- alert "Saved!"']); // normalize strips refs, keeps the line
    expect(d.delta.removed).toEqual([]);
    expect(d.delta.addedCount).toBe(1);
  });
});

describe('SnapshotCache (route-invalidated)', () => {
  it('recalls the last tree only when the route matches', () => {
    const c = new SnapshotCache();
    c.remember('k', '/a', TREE_A);
    expect(c.recall('k', '/a')).toBe(TREE_A);
    expect(c.recall('k', '/b')).toBeUndefined(); // route changed → invalidated
  });

  it('evicts the oldest entry past the cap', () => {
    const c = new SnapshotCache(1);
    c.remember('k1', '/a', 'x');
    c.remember('k2', '/a', 'y');
    expect(c.recall('k1', '/a')).toBeUndefined();
    expect(c.recall('k2', '/a')).toBe('y');
  });

  it('is LRU: a recalled (hot) key survives eviction of a colder one', () => {
    const c = new SnapshotCache(2);
    c.remember('a', '/', 'A');
    c.remember('b', '/', 'B');
    expect(c.recall('a', '/')).toBe('A'); // touch a -> most-recently-used
    c.remember('c', '/', 'C'); // must evict b (least-recently-used), not a
    expect(c.recall('a', '/')).toBe('A'); // survived
    expect(c.recall('b', '/')).toBeUndefined(); // evicted
    expect(c.recall('c', '/')).toBe('C');
  });
});

describe('applySnapshotDelta', () => {
  const raw = (tree: string, route = '/'): unknown => ({
    tree,
    status: { route, title: 'T' },
    nodes: 2,
  });
  const opts = (diff: boolean) => ({ sessionId: 's', scope: '', mode: 'full', diff });

  it('passes the full snapshot through when diff is off (but caches it)', () => {
    const c = new SnapshotCache();
    const out = applySnapshotDelta(raw(TREE_A), opts(false), c) as { tree?: string };
    expect(out.tree).toBe(TREE_A);
    expect(c.recall(snapshotCacheKey('s', '', 'full'), '/')).toBe(TREE_A);
  });

  it('first diff call returns full (no prior), second returns only the delta', () => {
    const c = new SnapshotCache();
    const first = applySnapshotDelta(raw(TREE_A), opts(true), c) as { tree?: string };
    expect(first.tree).toBe(TREE_A); // first look → full
    const second = applySnapshotDelta(raw(TREE_B), opts(true), c) as {
      mode?: string;
      delta?: { added: string[] };
      tree?: string;
    };
    expect(second.mode).toBe(SnapshotDeltaMode.DELTA);
    expect(second.tree).toBeUndefined(); // no full tree on a delta → tokens saved
    expect(second.delta?.added).toEqual(['- alert "Saved!"']);
  });

  it('returns unchanged (no tree, no delta) when nothing changed', () => {
    const c = new SnapshotCache();
    applySnapshotDelta(raw(TREE_A), opts(true), c);
    const again = applySnapshotDelta(raw(TREE_A), opts(true), c) as {
      mode?: string;
      tree?: string;
    };
    expect(again.mode).toBe(SnapshotDeltaMode.UNCHANGED);
    expect(again.tree).toBeUndefined();
  });

  it('a route change yields full again (never a cross-page delta)', () => {
    const c = new SnapshotCache();
    applySnapshotDelta(raw(TREE_A, '/a'), opts(true), c);
    const onB = applySnapshotDelta(raw(TREE_B, '/b'), opts(true), c) as { tree?: string };
    expect(onB.tree).toBe(TREE_B); // different route → full, not a delta
  });

  it('passes an error envelope through untouched', () => {
    const c = new SnapshotCache();
    expect(applySnapshotDelta({ error: 'no session' }, opts(true), c)).toEqual({
      error: 'no session',
    });
  });
});

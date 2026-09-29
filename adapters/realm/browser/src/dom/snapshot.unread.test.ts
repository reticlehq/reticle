import { describe, expect, it, afterEach } from 'vitest';
import { buildSnapshot, MAX_UNREAD_BRANCHES } from './snapshot.js';

/**
 * A truncated snapshot used to say only THAT it was cut, never WHERE. A reader could not re-read the
 * missing part, so "the error is not on the page" was reportable from a tree that stopped before it.
 * The cut now names its own frontier: the refs of the subtrees the walk never entered.
 */
describe('a truncated snapshot names the branches it did not read', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('omits both fields when nothing was cut', () => {
    document.body.innerHTML = '<button>Save</button>';
    const snap = buildSnapshot();
    expect(snap.truncated).toBe(false);
    expect(snap.unread).toBeUndefined();
    expect(snap.unreadOverflow).toBeUndefined();
  });

  it('names the unread branches, and each one re-reads to the part that was cut', () => {
    document.body.innerHTML = [
      '<div><button>One</button></div>',
      '<div><button>Two</button></div>',
      '<div><button>Three</button></div>',
    ].join('');
    const snap = buildSnapshot({ maxNodes: 1 });
    expect(snap.truncated).toBe(true);
    expect(snap.unread?.length).toBeGreaterThan(0);
    expect(snap.tree).not.toContain('Three');
    const rest = (snap.unread ?? [])
      .map((ref) => buildSnapshot({ scope: ref, includeRoot: true }).tree)
      .join('\n');
    expect(rest).toContain('Three');
  });

  it('a re-read at a branch includes the branch root itself, which the cut walk never emitted', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    const snap = buildSnapshot({ maxNodes: 1 });
    const ref = (snap.unread ?? [])[0] ?? '';
    expect(buildSnapshot({ scope: ref, includeRoot: true }).tree).toContain('Two');
  });

  it('declares an overflow rather than silently shortening the frontier', () => {
    const wide = Array.from(
      { length: MAX_UNREAD_BRANCHES + 5 },
      (_, i) => `<button>b${String(i)}</button>`,
    );
    document.body.innerHTML = wide.join('');
    const snap = buildSnapshot({ maxNodes: 1 });
    expect(snap.unread?.length).toBe(MAX_UNREAD_BRANCHES);
    expect(snap.unreadOverflow).toBe(true);
  });
});

/*
 * The depth cut was the silent one. Past `maxDepth` the walk simply returned: no `truncated`, no
 * `unread`, so a deeply nested form read as a page without it.
 */
describe('a snapshot cut by depth says so, and names where', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks the read truncated and names the branch it stopped above', () => {
    document.body.innerHTML =
      '<nav aria-label="outer"><nav aria-label="inner"><button>Deep</button></nav></nav>';
    const snap = buildSnapshot({ maxDepth: 1 });
    expect(snap.tree).not.toContain('Deep');
    expect(snap.truncated).toBe(true);
    const rest = (snap.unread ?? [])
      .map((ref) => buildSnapshot({ scope: ref, includeRoot: true }).tree)
      .join('\n');
    expect(rest).toContain('Deep');
  });
});

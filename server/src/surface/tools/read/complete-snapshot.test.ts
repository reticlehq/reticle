import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLETION_DEPTH,
  MAX_COMPLETION_READS,
  readCompleteTree,
} from './complete-snapshot.js';

/** A scripted browser: each scope answers with the tree and frontier the walk would have returned. */
function reader(pages: Record<string, unknown>): {
  read: (scope: string | undefined) => Promise<unknown>;
  scopes: (string | undefined)[];
} {
  const scopes: (string | undefined)[] = [];
  return {
    scopes,
    read: (scope) => {
      scopes.push(scope);
      return Promise.resolve(pages[scope ?? ''] ?? { tree: '' });
    },
  };
}

describe('a read that finishes what a truncated snapshot started', () => {
  it('leaves a complete read exactly as it was, in one read', async () => {
    const { read, scopes } = reader({ '': { tree: '- button "Save"', truncated: false } });
    const done = await readCompleteTree(read);
    expect(done.complete).toBe(true);
    expect(done.tree).toBe('- button "Save"');
    expect(scopes).toEqual([undefined]);
  });

  it('re-reads each cut branch at its own path and assembles the whole tree', async () => {
    const { read } = reader({
      '': { tree: '- button "One"', truncated: true, unread: ['e2', 'e3'] },
      e2: { tree: '- button "Two"', truncated: false },
      e3: { tree: '- button "Three"', truncated: true, unread: ['e4'] },
      e4: { tree: '- alert "Payment declined"', truncated: false },
    });
    const done = await readCompleteTree(read);
    expect(done.complete).toBe(true);
    expect(done.tree).toContain('Payment declined');
    expect(done.incompleteBecause).toBeUndefined();
  });

  it('reports an unassemblable tree instead of returning the partial one', async () => {
    const { read } = reader({
      '': { tree: '- button "One"', truncated: true, unread: ['e2'], unreadOverflow: true },
    });
    const done = await readCompleteTree(read);
    expect(done.complete).toBe(false);
    expect(done.incompleteBecause).toContain('more branches');
  });

  it('reports the read bound rather than silently stopping at it', async () => {
    const wide = Array.from({ length: MAX_COMPLETION_READS + 5 }, (_, i) => `e${String(i)}`);
    const { read } = reader({ '': { tree: '', truncated: true, unread: wide } });
    const done = await readCompleteTree(read);
    expect(done.complete).toBe(false);
    expect(done.reads).toBe(MAX_COMPLETION_READS);
    expect(done.incompleteBecause).toContain(String(MAX_COMPLETION_READS));
  });

  it('reports the depth bound rather than recursing forever on a hostile tree', async () => {
    // Every branch names one more branch, and never the same one twice — an unbounded chain.
    const read = (scope: string | undefined): Promise<unknown> =>
      Promise.resolve({ tree: '', truncated: true, unread: [`${scope ?? 'r'}x`] });
    const done = await readCompleteTree(read);
    expect(done.complete).toBe(false);
    expect(done.reads).toBe(MAX_COMPLETION_DEPTH);
    expect(done.incompleteBecause).toContain(String(MAX_COMPLETION_DEPTH));
  });

  it('treats a snapshot it cannot parse as incomplete, never as a finished read', async () => {
    const { read } = reader({ '': { tree: 42 } });
    const done = await readCompleteTree(read);
    expect(done.complete).toBe(false);
  });
});

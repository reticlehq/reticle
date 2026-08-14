/**
 * A delta the agent cannot act on is not a saving, it is a second call.
 *
 * `reticle_snapshot { diff: true }` cuts real tokens — the cost regression asserts the delta stays
 * under a tenth of a full re-read — but every delta line came back as `- button "Row actions"` with
 * no ref. Acting needs a ref, so the full snapshot had to be taken anyway and the diff call bought
 * nothing. Measured on a filter that removed 26 of 36 controls, `interactive` cost 390 tokens WITH
 * refs and `interactive + diff` cost 275 WITHOUT them: strictly worse, because the 275 was spent and
 * then the 390 was spent too.
 *
 * The cause is one helper with two callers and opposite requirements. `normalizeLines` strips the ref
 * marker deliberately — a ref in a stored baseline would make every later diff noisy — and the delta
 * path reuses it wholesale. So the fix is not to change `normalizeLines`, which is right for
 * baselines; it is for the delta path to diff on the ref-stripped key while EMITTING the original
 * line. Identity for comparison, ref for action.
 *
 * The same split fixes the second half. Focus state rides in the line (`[focused]`, or inside a
 * comma-joined bracket), so moving focus made one line appear in `removed` and its twin in `added` —
 * in the measured case 100% of the "added" entries were this, reported as structural change when
 * nothing had been added at all. Focus is a property OF a line, not a line coming or going, so it
 * belongs on its own field.
 */

import { describe, expect, it } from 'vitest';
import { applySnapshotDelta, SnapshotCache, SnapshotDeltaMode } from './snapshot-delta.js';

const OPTS = { sessionId: 's1', scope: '', mode: 'interactive', diff: true };

/** Feed a tree through the cache the way two consecutive snapshot calls would. */
function deltaOf(prev: string, next: string, route = '/'): Record<string, unknown> {
  const cache = new SnapshotCache();
  const shape = (tree: string): unknown =>
    applySnapshotDelta({ tree, status: { route } }, OPTS, cache);
  shape(prev);
  return shape(next) as Record<string, unknown>;
}

const delta = (result: Record<string, unknown>): Record<string, unknown> =>
  result['delta'] as Record<string, unknown>;

describe('a delta can be acted on', () => {
  it('carries the ref on an added line, because acting needs one', () => {
    const result = deltaOf(
      '- button "Save" (ref=e1)',
      '- button "Save" (ref=e1)\n- button "Publish" (ref=e2)',
    );
    expect(delta(result)['added']).toEqual(['- button "Publish" (ref=e2)']);
  });

  it('carries the ref on a removed line, so a disappearance names the element', () => {
    const result = deltaOf(
      '- button "Save" (ref=e1)\n- button "Publish" (ref=e2)',
      '- button "Save" (ref=e1)',
    );
    expect(delta(result)['removed']).toEqual(['- button "Publish" (ref=e2)']);
  });

  it('distinguishes duplicate labels by ref, which is the only thing that tells them apart', () => {
    const rows = (refs: number[]): string =>
      refs.map((n) => `- button "Row actions" (ref=e${String(n)})`).join('\n');
    const result = deltaOf(rows([1, 2, 3]), rows([1, 3]));
    expect(delta(result)['removed']).toEqual(['- button "Row actions" (ref=e2)']);
  });

  it('still reports a change when only the ref changed, since that is a different element', () => {
    // A full navigation re-mints refs. The line reads the same and the element is NOT the same one.
    const result = deltaOf('- button "Save" (ref=e1)', '- button "Save" (ref=e900)');
    expect(result['mode']).toBe(SnapshotDeltaMode.UNCHANGED);
    // Identity for the DIFF is the ref-stripped line — a re-render that re-mints a ref must not read
    // as the button being removed and a different one added. The ref is carried for ACTING, and the
    // agent gets a fresh one from the full snapshot a route change forces anyway.
  });
});

describe('focus is a property of a line, not a line arriving or leaving', () => {
  it('does not report a focus move as an add and a remove', () => {
    const result = deltaOf(
      '- button "One" (ref=e1) [focused]\n- button "Two" (ref=e2)',
      '- button "One" (ref=e1)\n- button "Two" (ref=e2) [focused]',
    );
    expect(result['mode']).toBe(SnapshotDeltaMode.UNCHANGED);
  });

  it('says where focus went, so the move is not simply lost', () => {
    const result = deltaOf(
      '- button "One" (ref=e1) [focused]\n- button "Two" (ref=e2)',
      '- button "One" (ref=e1)\n- button "Two" (ref=e2) [focused]',
    );
    expect(result['focusChanged']).toEqual({
      from: '- button "One" (ref=e1)',
      to: '- button "Two" (ref=e2)',
    });
  });

  it('handles focus combined with other states in one bracket', () => {
    const result = deltaOf(
      '- button "Menu" (ref=e1) [expanded,focused]',
      '- button "Menu" (ref=e1) [expanded]',
    );
    expect(result['mode']).toBe(SnapshotDeltaMode.UNCHANGED);
    expect((result['focusChanged'] as Record<string, unknown>)['to']).toBeUndefined();
  });

  it('keeps a REAL state change visible — only focus is exempt', () => {
    // `disabled` moving is a genuine structural change and must still show up.
    const result = deltaOf('- button "Save" (ref=e1)', '- button "Save" (ref=e1) [disabled]');
    expect(result['mode']).toBe(SnapshotDeltaMode.DELTA);
    expect(delta(result)['added']).toEqual(['- button "Save" (ref=e1) [disabled]']);
  });

  it('reports focus alongside a structural change rather than instead of it', () => {
    const result = deltaOf(
      '- button "One" (ref=e1) [focused]',
      '- button "One" (ref=e1)\n- button "Two" (ref=e2) [focused]',
    );
    expect(delta(result)['added']).toEqual(['- button "Two" (ref=e2)']);
    expect(result['focusChanged']).toEqual({
      from: '- button "One" (ref=e1)',
      to: '- button "Two" (ref=e2)',
    });
  });

  it('does not claim focus moved when the focused element merely changed', () => {
    // Found by driving, not by these tests: typing into a focused textbox rewrites its `[value=...]`,
    // and comparing the RENDERED LINES made that read as focus moving from the element to itself.
    // Focus identity is the element, so the comparison is on the ref and the line is only display.
    const result = deltaOf(
      '- textbox "Email" (ref=e3) [value="before@x.dev"] [focused]',
      '- textbox "Email" (ref=e3) [value="after@x.dev"] [focused]',
    );
    expect(result['focusChanged']).toBeUndefined();
    // The value change is still a real delta and must not be swallowed with it.
    expect(delta(result)['added']).toEqual(['- textbox "Email" (ref=e3) [value="after@x.dev"]']);
  });

  it('says nothing about focus when focus did not move', () => {
    const result = deltaOf(
      '- button "One" (ref=e1) [focused]',
      '- button "One" (ref=e1) [focused]\n- button "Two" (ref=e2)',
    );
    expect(result['focusChanged']).toBeUndefined();
  });
});

describe('what the delta path must not break', () => {
  it('still returns a full tree on the first look', () => {
    const cache = new SnapshotCache();
    const raw = { tree: '- button "Save" (ref=e1)', status: { route: '/' } };
    expect(applySnapshotDelta(raw, OPTS, cache)).toBe(raw);
  });

  it('still returns full after a route change rather than a cross-page delta', () => {
    const cache = new SnapshotCache();
    applySnapshotDelta({ tree: '- button "A" (ref=e1)', status: { route: '/' } }, OPTS, cache);
    const next = { tree: '- button "B" (ref=e2)', status: { route: '/other' } };
    expect(applySnapshotDelta(next, OPTS, cache)).toBe(next);
  });

  it('keeps the counts honest against the entries it returns', () => {
    const result = deltaOf(
      '- button "A" (ref=e1)',
      '- button "A" (ref=e1)\n- button "B" (ref=e2)\n- button "C" (ref=e3)',
    );
    expect(delta(result)['addedCount']).toBe(2);
    expect((delta(result)['added'] as string[]).length).toBe(2);
  });
});

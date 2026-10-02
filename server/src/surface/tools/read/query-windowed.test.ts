/**
 * The false negative a windowed list used to manufacture, and the two halves of the fix.
 *
 * A `react-window` style list mounts only the rows on screen. A query walks the DOM, so it searched
 * a fraction of the list and answered "no match" for a row that exists — which an agent reads as
 * "the element is not there". That is a false negative produced by the TOOL rather than found in the
 * app, and the remedy was a tool the default surface does not advertise, so the agent that needed it
 * could not see it.
 *
 * The note is what removes the false negative. The flag is only what makes the note actionable.
 */

import { describe, expect, it } from 'vitest';
import { RENDERED_ONLY_NOTE, noteRenderedOnly } from './query-windowed.js';

describe('a miss says what it actually searched', () => {
  it('tells a caller that nothing matched among the RENDERED nodes', () => {
    const out = noteRenderedOnly({ elements: [], count: 0 }) as { note?: string };
    expect(out.note).toBe(RENDERED_ONLY_NOTE);
  });

  it('names the flag that searches the rest, so the note can be acted on', () => {
    expect(RENDERED_ONLY_NOTE).toContain('reticle_act');
  });

  it('says nothing when something matched — a note on a hit is noise', () => {
    const out = noteRenderedOnly({ elements: [{ ref: 'e1' }], count: 1 }) as { note?: string };
    expect(out.note).toBeUndefined();
  });

  /*
   * The read path already uses `note` to explain a capped or truncated answer. Overwriting it would
   * replace a fact about THIS result with a general remark — the specific losing to the generic,
   * which is the wrong direction for something a caller is meant to act on.
   */
  it('does not overwrite a note the result already carried', () => {
    const out = noteRenderedOnly({
      elements: [],
      count: 0,
      note: 'the snapshot hit its node cap',
    }) as { note?: string };
    expect(out.note).toBe('the snapshot hit its node cap');
  });

  it('counts a count_only result, which carries no elements array', () => {
    const out = noteRenderedOnly({ count: 0 }) as { note?: string };
    expect(out.note).toBe(RENDERED_ONLY_NOTE);
  });

  it('leaves a non-object result alone rather than wrapping it', () => {
    expect(noteRenderedOnly(undefined)).toBeUndefined();
    expect(noteRenderedOnly('an error string')).toBe('an error string');
  });

  /*
   * An error envelope is this codebase's refusal convention, and it has no `elements` and no
   * `count`. Attaching "searched the rendered nodes" to a refusal would describe a search that never
   * happened — the same class of invention the note exists to prevent.
   */
  it('does not tell a refusal that it searched anything', () => {
    const refusal = { error: 'no connected session' };
    expect(noteRenderedOnly(refusal)).toEqual(refusal);
  });
});

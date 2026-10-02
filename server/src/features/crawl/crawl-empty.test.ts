/**
 * `crawl` reported `stepsRun: 0` with no `error` field and nothing else to go on.
 *
 * Reported from a sweep, including on a page with 34 interactive elements. It could not be
 * reproduced here — crawl drives bench-app correctly — and `interactiveFound` and the click loop read
 * the same list, so from the outside "found none" and "found some and clicked none" are the same
 * answer: a bare zero.
 *
 * That is the same defect as every other silent empty read: a result nobody can act on. Until the
 * cause is known, the report has to say which of the possible zeros it is, so the next occurrence
 * carries its own diagnosis instead of needing one inferred.
 */

import { describe, expect, it } from 'vitest';
import { crawlEmptyNote } from './crawl-empty.js';

describe('why a crawl clicked nothing', () => {
  it('says so when the page had no interactive controls at all', () => {
    const note = crawlEmptyNote({
      interactiveFound: 0,
      stepsRun: 0,
      maxSteps: 25,
      truncated: false,
    });
    expect(note).toContain('no interactive controls');
  });

  it('distinguishes "found controls but clicked none" — the reported case', () => {
    // 34 found, 0 clicked. Whatever the cause, it is NOT an empty page, and saying so is the
    // difference between a diagnosis and a guess.
    const note = crawlEmptyNote({
      interactiveFound: 34,
      stepsRun: 0,
      maxSteps: 25,
      truncated: false,
    });
    expect(note).toContain('34');
    expect(note).toContain('none of them');
  });

  it('names a maxSteps of zero, which is the one self-inflicted zero', () => {
    const note = crawlEmptyNote({
      interactiveFound: 34,
      stepsRun: 0,
      maxSteps: 0,
      truncated: false,
    });
    expect(note).toContain('maxSteps');
  });

  it('mentions truncation, because a floor is not a total', () => {
    const note = crawlEmptyNote({
      interactiveFound: 0,
      stepsRun: 0,
      maxSteps: 25,
      truncated: true,
    });
    expect(note).toContain('snapshot');
  });

  it('says nothing when the crawl actually ran', () => {
    expect(
      crawlEmptyNote({ interactiveFound: 7, stepsRun: 7, maxSteps: 25, truncated: false }),
    ).toBeUndefined();
  });
});

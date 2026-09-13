import { describe, expect, it } from 'vitest';
import { NO_EDITS_OBSERVED, isSameEditEpoch } from './edit-epoch.js';

/**
 * Which round of source edits an observation belongs to.
 *
 * The document id answers "was this page replaced". It cannot answer "was this CODE replaced": a hot
 * update swaps modules and re-renders inside the SAME document, so the id an agent is comparing
 * against never moves. An agent that edits and verifies in a loop therefore reads observations of
 * code it has already replaced, with nothing marking them.
 */

describe('isSameEditEpoch', () => {
  it('counts evidence from the current epoch as current', () => {
    expect(isSameEditEpoch(3, 3)).toBe(true);
  });

  it('counts evidence from an earlier epoch as NOT current', () => {
    expect(isSameEditEpoch(2, 3)).toBe(false);
  });

  it('counts UNSTAMPED evidence as current, exactly as isSameDocument does', () => {
    // An SDK older than this field stamps nothing, and an app with no hot-update channel stamps
    // nothing either. Reading either as "foreign" would make those installations silently stop
    // reporting real contradictions, which is the failure this whole family of checks exists to
    // avoid — a tool that quietly finds nothing is worse than one that occasionally over-reports.
    expect(isSameEditEpoch(undefined, 3)).toBe(true);
    expect(isSameEditEpoch(2, undefined)).toBe(true);
    expect(isSameEditEpoch(undefined, undefined)).toBe(true);
  });

  it('counts everything as current while no edit has been observed', () => {
    // Absence of hot-update support means UNKNOWN, never "no edits happened" — so the epoch nobody
    // has advanced must not start excluding or labelling anything.
    expect(isSameEditEpoch(NO_EDITS_OBSERVED, NO_EDITS_OBSERVED)).toBe(true);
    expect(isSameEditEpoch(undefined, NO_EDITS_OBSERVED)).toBe(true);
  });
});

/**
 * Coverage counted by REF, and a ref does not survive a re-render.
 *
 * Reported from a sweep of a Next app-router project: `total: 34, exercised: 0` after four
 * successful acts. App-router replaces a whole route segment on navigation, so every control the
 * agent drove is a new element with a new ref by the time coverage is asked. The number is then 0
 * forever, on every app that re-renders on interaction — which is most of them — and an agent
 * reading "you have exercised none of 34 controls" re-drives ground it already covered.
 *
 * Bench-app hid this: it reconciles in place, so refs happen to survive there and coverage reported
 * `exercised: 4` correctly. The defect only appears on frameworks that replace nodes.
 *
 * The label IS the identity that survives — `button "Deploy"` is the same control before and after a
 * re-render, and it is already parsed for the untouched list. So a control counts as exercised when
 * its ref was driven OR its label was.
 */

import { describe, expect, it } from 'vitest';
import { exercisedCount } from './coverage-identity.js';

const CONTROLS = [
  { ref: 'e10', label: 'button "Deploy"' },
  { ref: 'e11', label: 'button "Cancel"' },
  { ref: 'e12', label: 'button "Settings"' },
];

describe('a control the agent drove stays exercised across a re-render', () => {
  it('matches on ref when the ref survived', () => {
    expect(exercisedCount(CONTROLS, new Set(['e10']), new Set()).exercised).toBe(1);
  });

  it('matches on LABEL when the re-render gave it a new ref', () => {
    // The whole app-router case: nothing the agent drove is present by ref any more.
    expect(exercisedCount(CONTROLS, new Set(['e99']), new Set(['button "Deploy"'])).exercised).toBe(
      1,
    );
  });

  it('does not double-count a control matched both ways', () => {
    expect(exercisedCount(CONTROLS, new Set(['e10']), new Set(['button "Deploy"'])).exercised).toBe(
      1,
    );
  });

  it('reports what it could not account for, so 0 is never silently wrong', () => {
    // Refs driven that are neither present nor label-matched: the control is genuinely gone
    // (archive/delete/submit removed it). Counted apart so `exercised: 0` after real work is legible.
    expect(exercisedCount(CONTROLS, new Set(['e50', 'e51']), new Set()).droveGone).toBe(2);
  });

  it('a label match is NOT counted as gone — it is the same control, re-rendered', () => {
    const r = exercisedCount(CONTROLS, new Set(['e99']), new Set(['button "Deploy"']));
    expect(r.exercised).toBe(1);
    expect(r.droveGone, 'e99 is explained by the label match, not a removal').toBe(0);
  });

  it('an unlabelled control can only ever match by ref', () => {
    // Empty labels must not collapse into one bucket and mark every anonymous control as driven.
    const anon = [
      { ref: 'e20', label: '' },
      { ref: 'e21', label: '' },
    ];
    expect(exercisedCount(anon, new Set(['e20']), new Set([''])).exercised).toBe(1);
  });

  it('matches a control by TESTID, which survives what a re-render destroys', () => {
    // A control with a testid and no accessible name was unrecognisable after a re-render, so
    // coverage read `exercised: 0` however much work had been done — reported on three of four apps.
    const controls = [
      { ref: 'e30', label: 'button "" [data-testid=save-btn]' },
      { ref: 'e31', label: 'button "Cancel"' },
    ];
    expect(exercisedCount(controls, new Set(), new Set(['save-btn'])).exercised).toBe(1);
  });

  it('a testid match does not spill onto an unrelated control', () => {
    const controls = [{ ref: 'e40', label: 'button "Cancel"' }];
    expect(exercisedCount(controls, new Set(), new Set(['save-btn'])).exercised).toBe(0);
  });
});

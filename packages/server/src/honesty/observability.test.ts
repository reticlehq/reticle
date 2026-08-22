import { describe, expect, it } from 'vitest';
import { InstrumentationGapKind, instrumentationGap } from '@reticlehq/core';
import { coverageRegressed, observabilityOf } from './observability.js';

const gapOn = (ref: string) =>
  instrumentationGap(InstrumentationGapKind.NO_SOURCE_MAPPING, `${ref} has no source`, 'cost', {
    ref,
  });
const sessionWideGap = () =>
  instrumentationGap(InstrumentationGapKind.NO_STORE_REGISTERED, 'no store', 'cost');

describe('observabilityOf', () => {
  it('is every driven control when nothing was missing', () => {
    expect(observabilityOf(['e1', 'e2', 'e3'], [])).toEqual({
      driven: 3,
      observable: 3,
      percent: 100,
    });
  });

  it('discounts the controls a gap was attached to', () => {
    expect(observabilityOf(['e1', 'e2', 'e3', 'e4'], [gapOn('e2')])).toEqual({
      driven: 4,
      observable: 3,
      percent: 75,
    });
  });

  it('counts a control once however many gaps it collected', () => {
    const many = [
      gapOn('e2'),
      instrumentationGap(InstrumentationGapKind.NO_SIGNAL_ON_MUTATION, 'silent', 'cost', {
        ref: 'e2',
      }),
    ];
    expect(observabilityOf(['e1', 'e2'], many).observable).toBe(1);
  });

  /**
   * A store or a route signal is missing from the APP, not from a control. Counting it against a
   * particular button would put the number on the wrong thing and would make it move when the agent
   * happened to drive a different control — which is a number nobody can act on.
   */
  it('ignores a gap that is about the app rather than a control', () => {
    expect(observabilityOf(['e1', 'e2'], [sessionWideGap()])).toEqual({
      driven: 2,
      observable: 2,
      percent: 100,
    });
  });

  /**
   * A gap on something outside the driven set — a control from an earlier route, since replaced —
   * must not push `observable` below zero or invent a denominator.
   */
  it('never counts a gap on a control that was not driven', () => {
    expect(observabilityOf(['e1'], [gapOn('e99')])).toEqual({
      driven: 1,
      observable: 1,
      percent: 100,
    });
  });

  /**
   * Nothing driven is not "fully observable". 0/0 reported as 100% is the most flattering possible
   * reading of no evidence at all, and a coverage number that starts perfect is one nobody believes
   * the first time it drops.
   */
  it('reports no percentage at all when nothing was driven', () => {
    expect(observabilityOf([], [])).toEqual({ driven: 0, observable: 0 });
    expect(observabilityOf([], [sessionWideGap()])).toEqual({ driven: 0, observable: 0 });
  });

  it('rounds rather than inventing precision', () => {
    expect(observabilityOf(['a', 'b', 'c'], [gapOn('a')]).percent).toBe(67);
  });
});

describe('coverageRegressed', () => {
  /**
   * The guard ships with the number, not after it. A coverage figure with no downgrade check is one
   * that gets gamed, and we would be the ones teaching agents to game it: removing an assertion is
   * the cheapest way to stop a gap firing.
   */
  it('reports a drop against the best this project has reached', () => {
    expect(coverageRegressed({ percent: 90 }, { driven: 10, observable: 6, percent: 60 })).toEqual({
      was: 90,
      now: 60,
    });
  });

  it('says nothing when coverage held or improved', () => {
    expect(
      coverageRegressed({ percent: 60 }, { driven: 10, observable: 6, percent: 60 }),
    ).toBeUndefined();
    expect(
      coverageRegressed({ percent: 60 }, { driven: 10, observable: 9, percent: 90 }),
    ).toBeUndefined();
  });

  it('says nothing on the first run, when there is no best to fall from', () => {
    expect(
      coverageRegressed(undefined, { driven: 10, observable: 6, percent: 60 }),
    ).toBeUndefined();
  });

  /**
   * A run that drove almost nothing is not evidence of a regression — it is evidence of a short run.
   * Without this, ending a session after one action would report a collapse every time.
   */
  it('says nothing when the run is too small to compare', () => {
    expect(
      coverageRegressed({ percent: 90 }, { driven: 1, observable: 0, percent: 0 }),
    ).toBeUndefined();
  });

  it('says nothing when this run measured nothing at all', () => {
    expect(coverageRegressed({ percent: 90 }, { driven: 0, observable: 0 })).toBeUndefined();
  });
});

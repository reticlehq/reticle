/**
 * One switch that means what it says.
 *
 * `.reticle.json` had a single `journal: false`, which is the only answer somebody could give to
 * "this directory is too big" — and it answered by turning off the thing the product is FOR. The
 * bounds themselves were four constants nobody could reach.
 *
 * Every field is independently optional, and an unreadable one falls back to the default rather
 * than throwing: a typo in a config file must never be the reason a daemon will not start, and
 * retention refusing to run is exactly the wrong failure for a directory that is already too big.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETAIN, readRetainPolicy } from './retain-policy.js';

describe('readRetainPolicy', () => {
  it('is the defaults when nothing is configured', () => {
    expect(readRetainPolicy(undefined)).toEqual(DEFAULT_RETAIN);
    expect(readRetainPolicy({})).toEqual(DEFAULT_RETAIN);
  });

  it('takes the counts a project states', () => {
    const policy = readRetainPolicy({ retain: { sessions: 3, visual: 1, feedback: 2 } });
    expect(policy.sessions).toBe(3);
    expect(policy.visual).toBe(1);
    expect(policy.feedback).toBe(2);
  });

  it('states the budget in megabytes, because that is the unit the problem arrives in', () => {
    expect(readRetainPolicy({ retain: { budgetMb: 2 } }).budgetBytes).toBe(2 * 1024 * 1024);
  });

  it('reads 0 as keep none, which is a real answer and not a missing one', () => {
    const policy = readRetainPolicy({ retain: { sessions: 0, budgetMb: 0 } });
    expect(policy.sessions).toBe(0);
    expect(policy.budgetBytes).toBe(0);
  });

  /*
   * Each field falls back on its own. A project that mistypes one bound still gets the other three,
   * which matters because the alternative is silently reverting every bound the user did set.
   */
  it('falls back per field, never wholesale', () => {
    const policy = readRetainPolicy({
      retain: { sessions: 5, visual: 'lots', feedback: -1, budgetMb: 1.5 },
    });
    expect(policy.sessions).toBe(5);
    expect(policy.visual).toBe(DEFAULT_RETAIN.visual);
    expect(policy.feedback).toBe(DEFAULT_RETAIN.feedback);
    expect(policy.budgetBytes).toBe(DEFAULT_RETAIN.budgetBytes);
  });

  it('ignores a retain that is not an object at all', () => {
    expect(readRetainPolicy({ retain: 'yes' })).toEqual(DEFAULT_RETAIN);
    expect(readRetainPolicy({ retain: [20] })).toEqual(DEFAULT_RETAIN);
  });

  it('keeps journalling on unless the project asks for no sessions at all', () => {
    expect(readRetainPolicy({}).sessions > 0).toBe(true);
    expect(readRetainPolicy({ retain: { sessions: 0 } }).sessions > 0).toBe(false);
  });
});

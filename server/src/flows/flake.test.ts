import { describe, expect, it } from 'vitest';
import { emptyRecord, flakeRate, isFlaky, recordOutcome } from './flake.js';

function accrue(outcomes: boolean[]): ReturnType<typeof emptyRecord> {
  let record = emptyRecord();
  for (const passed of outcomes) record = recordOutcome(record, passed);
  return record;
}

describe('flake ledger', () => {
  it('accrues runs and fails', () => {
    const record = accrue([true, false, true, false, true]);
    expect(record).toEqual({ runs: 5, fails: 2 });
    expect(flakeRate(record)).toBeCloseTo(0.4);
  });

  it('flags a flow that both passes and fails at unchanged code as flaky', () => {
    expect(isFlaky(accrue([true, false, true, true, false]))).toBe(true);
  });

  it('does not flag a consistently failing flow (a real red, not flake)', () => {
    expect(isFlaky(accrue([false, false, false, false, false]))).toBe(false);
  });

  it('does not flag a consistently passing flow', () => {
    expect(isFlaky(accrue([true, true, true, true, true]))).toBe(false);
  });

  it('needs enough runs before judging flakiness', () => {
    expect(isFlaky(accrue([true, false]))).toBe(false); // only 2 runs
  });
});

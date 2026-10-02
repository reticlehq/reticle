/**
 * A session's event ledger must be visible before it is a problem.
 *
 * A repeating uncaught error wrote one session's `events.jsonl` until the disk
 * was full. Three things failed together; this covers the third, which the report calls the
 * one that matters: *nothing noticed*. Neither the daemon, nor `doctor`, nor any session-health
 * counter said a word, and the user found out when the disk was full (#986).
 *
 * The cap that now refuses the write bounds the damage. It does not make the writing visible, and a
 * ledger silently approaching its ceiling is still a dev tool writing hard to somebody's repo.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_HEALTH } from '@reticlehq/core';
import { healthNotices, ledgerNotice } from './session-health.js';

const CAP = 1_000_000;
const NOTICE_AT = CAP * SESSION_HEALTH.LEDGER_NOTICE_FRACTION;

describe('the health block names the ledger once it is worth naming', () => {
  it('says nothing for a ledger with room to spare', () => {
    expect(ledgerNotice({ bytes: NOTICE_AT - 1, capBytes: CAP })).toEqual({});
  });

  it('reports the size and the ceiling it is measured against', () => {
    const notice = ledgerNotice({ bytes: NOTICE_AT, capBytes: CAP });

    // Both numbers, not a percentage: a reader deciding whether to act needs the ceiling, and a
    // bare fraction cannot be turned back into one.
    expect(notice).toEqual({ ledger: { bytes: NOTICE_AT, capBytes: CAP } });
  });

  it('keeps reporting as the ledger fills', () => {
    expect(ledgerNotice({ bytes: CAP, capBytes: CAP })).toEqual({
      ledger: { bytes: CAP, capBytes: CAP },
    });
  });

  it('is absent when the size has not been measured', () => {
    // `undefined` before the first append. A zero reported then would be a claim, not a reading,
    // and a reader must be able to tell "not measured" from "empty".
    expect(ledgerNotice(undefined)).toEqual({});
  });

  it('is absent rather than dividing by a zero cap', () => {
    expect(ledgerNotice({ bytes: 10, capBytes: 0 })).toEqual({});
  });

  it('warns while there is still room to act', () => {
    // The point of the threshold. The runaway in the report crosses the last tenth of a cap in
    // minutes, so a notice that waited for 90% would arrive after the decision it informs.
    expect(SESSION_HEALTH.LEDGER_NOTICE_FRACTION).toBeLessThanOrEqual(0.5);
    expect(SESSION_HEALTH.LEDGER_NOTICE_FRACTION).toBeGreaterThan(0);
  });
});

describe('healthNotices carries both absence-gated facts', () => {
  it('is empty for a healthy session', () => {
    expect(healthNotices([], 0, { bytes: 1, capBytes: CAP })).toEqual({});
  });

  it('carries the ledger once it is worth naming', () => {
    expect(healthNotices([], 0, { bytes: CAP, capBytes: CAP })).toEqual({
      ledger: { bytes: CAP, capBytes: CAP },
    });
  });
});

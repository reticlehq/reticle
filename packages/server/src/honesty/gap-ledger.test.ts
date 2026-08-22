import { describe, expect, it } from 'vitest';
import { InstrumentationGapKind, instrumentationGap } from '@reticlehq/core';
import { GapLedger, noteSessionGaps } from './gap-ledger.js';

const gap = (kind: InstrumentationGapKind, missing = 'm') =>
  instrumentationGap(kind, missing, 'cost');

const SOURCE = gap(InstrumentationGapKind.NO_SOURCE_MAPPING);
const STORE = gap(InstrumentationGapKind.NO_STORE_REGISTERED);

describe('GapLedger', () => {
  it('starts empty, so a clean session never has anything to answer for', () => {
    const ledger = new GapLedger();
    expect(ledger.open()).toEqual([]);
    expect(ledger.hasOpen).toBe(false);
    expect(ledger.everSeen).toEqual([]);
  });

  it('holds what the last verdict reported', () => {
    const ledger = new GapLedger();
    ledger.note([SOURCE, STORE]);
    expect(ledger.open()).toHaveLength(2);
    expect(ledger.hasOpen).toBe(true);
  });

  /**
   * The behaviour the whole mechanism turns on. An agent that hits a gap, instruments the app and
   * re-verifies has CLOSED it — the later verdict stops emitting that kind. A ledger that kept
   * reporting it would punish exactly the behaviour this exists to cause, and nobody instruments an
   * app twice for a tool that did not notice the first time.
   */
  it('closes a gap when a later verdict stops reporting it', () => {
    const ledger = new GapLedger();
    ledger.note([SOURCE]);
    expect(ledger.hasOpen).toBe(true);

    ledger.note([]);
    expect(ledger.open()).toEqual([]);
    expect(ledger.hasOpen).toBe(false);
  });

  it('closes only the gap that was actually fixed', () => {
    const ledger = new GapLedger();
    ledger.note([SOURCE, STORE]);
    ledger.note([STORE]);
    expect(ledger.open().map((g) => g.kind)).toEqual([InstrumentationGapKind.NO_STORE_REGISTERED]);
  });

  /**
   * A closed gap is still worth SAYING — "you hit this and fixed it" belongs in a summary — but it
   * is not a reason to withhold done. Two different questions, two different fields.
   */
  it('remembers a fixed gap for the summary without holding it open', () => {
    const ledger = new GapLedger();
    ledger.note([SOURCE]);
    ledger.note([]);
    expect(ledger.hasOpen).toBe(false);
    expect(ledger.everSeen).toEqual([InstrumentationGapKind.NO_SOURCE_MAPPING]);
  });

  it('does not double-count a kind seen across many verdicts', () => {
    const ledger = new GapLedger();
    ledger.note([SOURCE]);
    ledger.note([SOURCE]);
    ledger.note([SOURCE]);
    expect(ledger.everSeen).toEqual([InstrumentationGapKind.NO_SOURCE_MAPPING]);
    expect(ledger.open()).toHaveLength(1);
  });

  it('collapses repeats inside one verdict', () => {
    const ledger = new GapLedger();
    ledger.note([SOURCE, SOURCE, SOURCE]);
    expect(ledger.open()).toHaveLength(1);
  });

  it('keeps two gaps of one kind that name different things', () => {
    const ledger = new GapLedger();
    ledger.note([
      gap(InstrumentationGapKind.NO_STORE_REGISTERED, 'cart'),
      gap(InstrumentationGapKind.NO_STORE_REGISTERED, 'session'),
    ]);
    expect(ledger.open()).toHaveLength(2);
    expect(ledger.everSeen).toEqual([InstrumentationGapKind.NO_STORE_REGISTERED]);
  });
});

/**
 * The seam, pinned. `Session` is satisfied structurally, so dozens of specs — and any consumer
 * embedding this engine — hand the verdict path an object literal with no ledger on it. Recording
 * is a side effect and must never be the reason a verdict fails to return.
 */
describe('noteSessionGaps', () => {
  it('records against a session that keeps a ledger', () => {
    const session = { gaps: new GapLedger() };
    noteSessionGaps(session, [SOURCE]);
    expect(session.gaps.hasOpen).toBe(true);
  });

  it('is a no-op, not a throw, for a session that keeps none', () => {
    expect(() => {
      noteSessionGaps({}, [SOURCE]);
    }).not.toThrow();
  });

  it('closes through the helper too', () => {
    const session = { gaps: new GapLedger() };
    noteSessionGaps(session, [SOURCE]);
    noteSessionGaps(session, []);
    expect(session.gaps.hasOpen).toBe(false);
  });
});

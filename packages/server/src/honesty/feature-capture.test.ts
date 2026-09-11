import { describe, expect, it } from 'vitest';
import { IntentState, Verified, type Intent, type JournalAction } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { CaptureLedger, foldFeatureCapture, type CapturedCall } from './feature-capture.js';

const ACTED_REF = 'e7';
const OTHER_REF = 'e9';
const CLAIM = 'the badge reads checked in';

function action(overrides: Partial<JournalAction> = {}): JournalAction {
  return {
    v: 1,
    actionId: 'a1',
    tool: ReticleTool.ACT_AND_WAIT,
    args: { ref: ACTED_REF },
    settled: true,
    tRange: { from: 0, to: 1 },
    at: 0,
    ...overrides,
  };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'checkin',
    statement: CLAIM,
    state: IntentState.DECLARED,
    declaredAt: 1,
    ...overrides,
  };
}

function fold(input: {
  calls?: readonly CapturedCall[];
  dropped?: number;
  actions?: readonly JournalAction[];
  intents?: readonly Intent[];
  finalActions?: number;
}) {
  return foldFeatureCapture({
    calls: input.calls ?? [],
    dropped: input.dropped ?? 0,
    actions: input.actions ?? [],
    intents: input.intents ?? [],
    finalActions: input.finalActions ?? (input.actions ?? []).length,
  });
}

describe('CaptureLedger', () => {
  it('counts a reticle_context call', () => {
    const ledger = new CaptureLedger();
    ledger.note({ tool: ReticleTool.CONTEXT, afterActions: 3 });

    expect(fold({ calls: ledger.calls(), finalActions: 3 }).context?.calls).toBe(1);
  });

  it('reports the step each reticle_context call was made at', () => {
    const ledger = new CaptureLedger();
    ledger.note({ tool: ReticleTool.CONTEXT, afterActions: 0 });
    ledger.note({ tool: ReticleTool.CONTEXT, afterActions: 4 });

    expect(fold({ calls: ledger.calls(), finalActions: 4 }).context?.atSteps).toEqual([0, 4]);
  });
});

describe('foldFeatureCapture', () => {
  it('reads as not observed for a session with no journal and no recorded call', () => {
    const report = fold({});

    expect(report.observed).toBe(false);
    expect(report.context).toBeUndefined();
  });

  it('counts verdicts drawn with no intent covering them', () => {
    const verdict = { claim: CLAIM, verified: Verified.YES };
    const report = fold({
      actions: [action({ effect: verdict }), action({ actionId: 'a2', effect: verdict })],
      intents: [],
    });

    expect(report.missed?.verdictsWithNoIntentDeclared).toBe(2);
  });

  it('counts no uncovered verdict once the ledger holds an intent', () => {
    const report = fold({
      actions: [action({ effect: { claim: CLAIM, verified: Verified.YES } })],
      intents: [intent()],
    });

    expect(report.missed?.verdictsWithNoIntentDeclared).toBe(0);
  });

  it('counts a read that re-fetched an already-established fact', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.INSPECT, subject: ACTED_REF, afterActions: 1 }],
      actions: [action()],
    });

    expect(report.missed?.refetchedEstablished).toBe(1);
  });

  it('does not count a first look as a re-fetch', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.INSPECT, subject: ACTED_REF, afterActions: 0 }],
      actions: [action()],
      finalActions: 1,
    });

    expect(report.missed?.refetchedEstablished).toBe(0);
  });

  it('does not count a read of a subject nothing established', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.INSPECT, subject: OTHER_REF, afterActions: 1 }],
      actions: [action()],
    });

    expect(report.missed?.refetchedEstablished).toBe(0);
  });

  it('reads `acted` when an action followed the context call', () => {
    const report = fold({
      calls: [
        { tool: ReticleTool.CONTEXT, afterActions: 1 },
        { tool: ReticleTool.QUERY, afterActions: 2 },
      ],
      actions: [action(), action({ actionId: 'a2' })],
    });

    expect(report.context?.acted).toBe(1);
    expect(report.context?.refetched).toBe(0);
  });

  it('reads `refetched` when the next read asked for what the context had just supplied', () => {
    const report = fold({
      calls: [
        { tool: ReticleTool.CONTEXT, afterActions: 1 },
        { tool: ReticleTool.INSPECT, subject: ACTED_REF, afterActions: 1 },
      ],
      actions: [action()],
    });

    expect(report.context?.refetched).toBe(1);
    expect(report.context?.acted).toBe(0);
  });

  it('reads `acted` when the run ended on an action after the last context call', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.CONTEXT, afterActions: 0 }],
      actions: [action()],
      finalActions: 1,
    });

    expect(report.context?.acted).toBe(1);
  });

  it('reads `nothingAfter` when nothing at all followed the context call', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.CONTEXT, afterActions: 1 }],
      actions: [action()],
      finalActions: 1,
    });

    expect(report.context?.nothingAfter).toBe(1);
    expect(report.context?.acted).toBe(0);
  });

  it('reports the intent ledger as declared and still open', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.CONTEXT, afterActions: 0 }],
      intents: [intent(), intent({ id: 'other', state: IntentState.PROVED })],
    });

    expect(report.intents).toEqual({ declared: 2, open: 1 });
  });

  it('says so when the ledger dropped calls rather than reporting a short count as complete', () => {
    const report = fold({
      calls: [{ tool: ReticleTool.CONTEXT, afterActions: 0 }],
      dropped: 3,
    });

    expect(report.truncated).toBe(true);
  });
});

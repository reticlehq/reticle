import { describe, expect, it } from 'vitest';
import { adjudicate, couldEverProve, type AdjudicationInput } from './adjudicator.js';
import { CHANNEL_DEFAULTS, ChannelId, Grade, Independence } from '../vocabulary/channel.js';
import { Declaration } from '../vocabulary/intent.js';
import { CloseCondition } from '../vocabulary/realm-surface.js';
import { AnomalyTier, Verdict } from '../vocabulary/verdict.js';
import { ProvenanceClass } from '../vocabulary/evidence.js';

/**
 * The rules, exercised as rules.
 *
 * `adjudicate` is normative — where an implementation disagrees with it, it is what the
 * specification means — so it is the one function in this package that must be pinned clause by
 * clause. Every test below names the clause it defends and the wrong answer it prevents.
 */

const SUBJECT = { surface: 'web', instance: 'i1', epoch: 3 } as const;

function channel(id: ChannelId) {
  return { id, ...CHANNEL_DEFAULTS[id] };
}

function evidence(
  id: string,
  channelId: ChannelId,
  cls: ProvenanceClass = ProvenanceClass.OBSERVED,
) {
  return {
    observation: {
      id,
      window: 'w1',
      channel: channelId,
      at: 10,
      value: {},
      summary: `${channelId} saw something`,
    },
    provenance: { class: cls, source: 'test', method: 'direct', subject: SUBJECT, at: 10 },
    independence: CHANNEL_DEFAULTS[channelId].independence,
    grade: CHANNEL_DEFAULTS[channelId].grade,
  };
}

function input(over: Partial<AdjudicationInput> = {}): AdjudicationInput {
  return {
    claim: {
      id: 'c1',
      statement: 'the order was placed',
      declaredAt: Declaration.BEFORE_ACTION,
      assertions: [
        { id: 'a1', predicate: {}, reads: 'POST /orders returned 200', channels: [ChannelId.NET] },
      ],
    },
    window: {
      id: 'w1',
      openedAt: 0,
      closedAt: 50,
      budgetMs: 8000,
      closes: CloseCondition.QUIESCENCE,
      closedBy: CloseCondition.QUIESCENCE,
      subject: SUBJECT,
    },
    channels: [channel(ChannelId.NET), channel(ChannelId.UI), channel(ChannelId.STATE)],
    evidence: [evidence('e1', ChannelId.NET)],
    coverage: { window: 'w1', observed: [ChannelId.NET, ChannelId.UI], blindSpots: [] },
    anomalies: [],
    assertionsHeld: true,
    ...over,
  };
}

describe('a yes has to be paid for', () => {
  it('is proved when independent consequence evidence closes a clean window', () => {
    const out = adjudicate(input());
    expect(out.verdict).toBe(Verdict.YES);
    expect(out.grade).toBe(Grade.CONSEQUENCE);
  });

  it('refuses to prove on channels the action itself produced', () => {
    // The clause the whole protocol exists for. The screen and the store agreeing is the subject
    // agreeing with itself; an application wrong about what it did is wrong on both, together.
    const out = adjudicate(
      input({
        claim: {
          id: 'c1',
          statement: 'the badge updated',
          declaredAt: Declaration.BEFORE_ACTION,
          assertions: [
            { id: 'a1', predicate: {}, reads: 'badge reads 1', channels: [ChannelId.UI] },
          ],
        },
        evidence: [evidence('e1', ChannelId.UI), evidence('e2', ChannelId.STATE)],
      }),
    );
    expect(out.verdict).toBe(Verdict.UNKNOWN);
    expect(out.reasons.join(' ')).toMatch(/not evidence that it acted/);
  });

  it('refuses to prove on a learned belief, however confident', () => {
    // The memory fence, at the point it matters. Repetition is not authority.
    const out = adjudicate({
      ...input(),
      evidence: [evidence('e1', ChannelId.NET, ProvenanceClass.LEARNED)],
    });
    expect(out.verdict).toBe(Verdict.UNKNOWN);
  });

  it('refuses to prove a claim written down after the action', () => {
    const out = adjudicate({
      ...input(),
      claim: { ...input().claim, declaredAt: Declaration.AFTER_ACTION },
    });
    expect(out.verdict).toBe(Verdict.UNKNOWN);
    expect(out.reasons.join(' ')).toMatch(/after the action/);
  });

  it('refuses to prove over a window that ran out of budget', () => {
    const out = adjudicate({
      ...input(),
      window: { ...input().window, closedBy: CloseCondition.BUDGET_EXHAUSTED },
    });
    expect(out.verdict).toBe(Verdict.UNKNOWN);
  });
});

describe('could not see is decided before it did not happen', () => {
  it('answers unknown when the claim reads a channel nobody declared', () => {
    // Checked before any evidence is weighed: "nothing was watching" and "it did not happen"
    // produce identical empty evidence and mean opposite things.
    const out = adjudicate(input({ channels: [channel(ChannelId.UI)] }));
    expect(out.verdict).toBe(Verdict.UNKNOWN);
    expect(out.reasons.join(' ')).toMatch(/cannot observe/);
  });

  it('answers unknown when an impeaching blind spot falls on what the claim needed', () => {
    const out = adjudicate(
      input({
        coverage: {
          window: 'w1',
          observed: [ChannelId.NET],
          blindSpots: [
            {
              kind: 'buffer-truncated',
              channel: ChannelId.NET,
              detail: 'the request log was capped',
              impeaching: true,
            },
          ],
        },
      }),
    );
    expect(out.verdict).toBe(Verdict.UNKNOWN);
  });

  it('is unmoved by a blind spot the claim never needed', () => {
    // Without this an honest implementation is punished for declaring blind spots, and learns to
    // declare fewer — which is the opposite of what the field is for.
    const out = adjudicate(
      input({
        coverage: {
          window: 'w1',
          observed: [ChannelId.NET],
          blindSpots: [
            {
              kind: 'channel-unobserved',
              channel: ChannelId.STORAGE,
              detail: 'storage is not watched here',
              impeaching: false,
            },
          ],
        },
      }),
    );
    expect(out.verdict).toBe(Verdict.YES);
  });
});

describe('an anomaly convicts only on independent channels', () => {
  const anomaly = (between: [ChannelId, ChannelId], tier: AnomalyTier = AnomalyTier.OBSERVED) => ({
    kind: 'advanced-over-failure' as const,
    tier,
    claim: 'the screen moved forward',
    counter: 'a write in the same window failed',
    between,
    evidence: [],
  });

  it('forces no when the screen disagrees with the network', () => {
    const out = adjudicate(input({ anomalies: [anomaly([ChannelId.UI, ChannelId.NET])] }));
    expect(out.verdict).toBe(Verdict.NO);
  });

  it('does NOT force no when the screen disagrees with the store', () => {
    // Both are produced by the same code path. Real, worth saying, and not proof of a failure.
    // This is the aviation rule: two-of-three voting is valid over independent sensors only.
    const out = adjudicate(input({ anomalies: [anomaly([ChannelId.UI, ChannelId.STATE])] }));
    expect(out.verdict).toBe(Verdict.YES);
  });

  it('downgrades rather than convicts on an absence-derived anomaly', () => {
    const out = adjudicate(
      input({
        anomalies: [anomaly([ChannelId.TIME, ChannelId.NET], AnomalyTier.ABSENCE_DERIVED)],
        channels: [channel(ChannelId.NET), channel(ChannelId.TIME), channel(ChannelId.UI)],
      }),
    );
    expect(out.verdict).toBe(Verdict.UNKNOWN);
  });
});

describe('nothing declared is its own answer', () => {
  it('is no-fault over a cleanly closed window', () => {
    const out = adjudicate(input({ claim: { ...input().claim, assertions: [] } }));
    expect(out.verdict).toBe(Verdict.NO_FAULT);
  });

  it('is unknown, not no-fault, when the window never closed cleanly', () => {
    // no-fault requires a clean close, or it becomes the green-forever button that an
    // always-available "nothing was wrong" always becomes.
    const out = adjudicate(
      input({
        claim: { ...input().claim, assertions: [] },
        window: { ...input().window, closedBy: CloseCondition.BUDGET_EXHAUSTED },
      }),
    );
    expect(out.verdict).toBe(Verdict.UNKNOWN);
  });
});

describe('an implementation can know at startup whether it could ever prove anything', () => {
  it('says no for a presence-only implementation', () => {
    expect(couldEverProve([channel(ChannelId.UI), channel(ChannelId.VISUAL)])).toBe(false);
  });

  it('says yes once an independent consequence channel is declared', () => {
    expect(couldEverProve([channel(ChannelId.UI), channel(ChannelId.NET)])).toBe(true);
  });

  it('does not count an actuation-derived consequence channel as enough on its own', () => {
    // `state` is consequence-grade and derived from the action. Grade alone is not the test.
    expect(CHANNEL_DEFAULTS[ChannelId.STATE].grade).toBe(Grade.CONSEQUENCE);
    expect(CHANNEL_DEFAULTS[ChannelId.STATE].independence).toBe(Independence.ACTUATION_DERIVED);
    expect(couldEverProve([channel(ChannelId.STATE)])).toBe(false);
  });
});

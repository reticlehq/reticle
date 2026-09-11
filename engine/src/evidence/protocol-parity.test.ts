import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  CHANNEL_DEFAULTS,
  ChannelId as ProtocolChannel,
  BlindSpotKind,
  CloseCondition,
  Declaration,
  Grade,
  ProvenanceClass,
  Verdict,
} from '@reticlehq/openreality';
import { decideVerified } from './verified.js';
import { HonestyGrade, type HonestyBlock } from './honesty.js';
import { ChannelId, ContradictionKind, Verified } from '@reticlehq/core';

/**
 * Reticle's adjudicator, checked against the one the specification says is normative.
 *
 * `openreality`'s `adjudicate()` carries a sentence that has to be either true or removed: *where
 * an implementation disagrees with this function, this function is what the specification means*.
 * That sentence was written and never tested. An implementation is entitled to reach these
 * verdicts by another route — this one does, through eleven clauses and a great deal of
 * hard-earned detail the protocol does not describe — but it is not entitled to reach a DIFFERENT
 * verdict, and until something compares them nobody would know if it did.
 *
 * So each case below is one situation, expressed twice: once in the protocol's vocabulary and once
 * in Reticle's, adjudicated by both, and compared.
 *
 * ── ON THE DIVERGENCES ──────────────────────────────────────────────────────────────────────────
 * Where the two genuinely differ, the divergence is written down as its own test rather than
 * papered over by loosening the comparison. A parity test that quietly widens until it passes is
 * worse than no parity test, because it reports agreement it has stopped checking for.
 */

const CLEAN: HonestyBlock = {
  grade: HonestyGrade.NET,
  coverage: { partial: false },
  integrity: { clean: true, issues: [] },
  settled: true,
};

const SUBJECT = { surface: 'web', instance: 'doc-1', epoch: 2 } as const;

function protocolChannels(ids: readonly ProtocolChannel[]) {
  return ids.map((id) => ({ id, ...CHANNEL_DEFAULTS[id] }));
}

/** One situation, put to the protocol's adjudicator. */
function askProtocol(over: {
  reads?: readonly ProtocolChannel[];
  declares?: readonly ProtocolChannel[];
  assertionsHeld?: boolean | undefined;
  anomalies?: Parameters<typeof adjudicate>[0]['anomalies'];
  closedBy?: CloseCondition;
  declaredAt?: Declaration;
  /** Weaken the single piece of evidence, to reach clause 9. */
  grade?: Grade;
  /** A blind spot on this channel, to reach clause 6 from its impeaching side. */
  impeachedOn?: ProtocolChannel;
}): Verdict {
  const reads = over.reads ?? [ProtocolChannel.NET];
  const declares = over.declares ?? [
    ProtocolChannel.NET,
    ProtocolChannel.UI,
    ProtocolChannel.STATE,
  ];
  return adjudicate({
    claim: {
      id: 'c1',
      statement: 'the thing happened',
      declaredAt: over.declaredAt ?? Declaration.BEFORE_ACTION,
      assertions: [{ id: 'a1', predicate: {}, reads: 'the thing', channels: [...reads] }],
    },
    window: {
      id: 'w1',
      openedAt: 0,
      closedAt: 10,
      budgetMs: 8000,
      closes: CloseCondition.QUIESCENCE,
      closedBy: over.closedBy ?? CloseCondition.QUIESCENCE,
      subject: SUBJECT,
    },
    channels: protocolChannels(declares),
    evidence: [
      {
        observation: {
          id: 'e1',
          window: 'w1',
          channel: ProtocolChannel.NET,
          at: 5,
          value: {},
          summary: 'a request went out and came back',
        },
        provenance: {
          class: ProvenanceClass.OBSERVED,
          source: 'sdk',
          method: 'patched fetch',
          subject: SUBJECT,
          at: 5,
        },
        independence: CHANNEL_DEFAULTS[ProtocolChannel.NET].independence,
        grade: over.grade ?? Grade.CONSEQUENCE,
      },
    ],
    coverage: {
      window: 'w1',
      observed: [...declares],
      blindSpots:
        over.impeachedOn === undefined
          ? []
          : [
              {
                kind: BlindSpotKind.STILL_IN_FLIGHT,
                channel: over.impeachedOn,
                detail: 'a request had not settled when the window closed',
                impeaching: false,
              },
            ],
    },
    anomalies: over.anomalies ?? [],
    assertionsHeld: over.assertionsHeld ?? true,
  }).verdict;
}

describe('the two adjudicators agree on what a verdict is', () => {
  it('both prove a held claim over clean, independent evidence', () => {
    expect(askProtocol({})).toBe(Verdict.YES);
    expect(decideVerified({ pass: true, honesty: CLEAN, declaredConsequence: true }).verified).toBe(
      Verified.YES,
    );
  });

  it('both disprove a claim whose assertion failed', () => {
    expect(askProtocol({ assertionsHeld: false })).toBe(Verdict.NO);
    expect(decideVerified({ pass: false, honesty: CLEAN }).verified).toBe(Verified.NO);
  });

  it('both answer unknown when the claim reads a channel nobody declared', () => {
    // The clause both put FIRST, and for the same reason: any clause reaching a verdict before
    // this one reports a gap in the tooling as a fact about the application.
    expect(
      askProtocol({
        reads: [ProtocolChannel.STATE],
        declares: [ProtocolChannel.NET],
      }),
    ).toBe(Verdict.UNKNOWN);
    expect(
      decideVerified({
        pass: true,
        honesty: CLEAN,
        channelsRead: [ChannelId.STATE],
        channelsObservable: [ChannelId.NET],
      }).verified,
    ).toBe(Verified.UNKNOWN);
  });

  it('both let an observed contradiction outrank a passing assertion', () => {
    expect(
      askProtocol({
        anomalies: [
          {
            kind: 'advanced-over-failure',
            tier: 'observed',
            claim: 'the screen moved forward',
            counter: 'a write failed',
            between: [ProtocolChannel.UI, ProtocolChannel.NET],
            evidence: [],
          },
        ],
      }),
    ).toBe(Verdict.NO);
    expect(
      decideVerified({
        pass: true,
        honesty: CLEAN,
        contradictions: [{ kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED }],
      }).verified,
    ).toBe(Verified.NO);
  });

  it('both downgrade rather than convict on an absence-derived finding', () => {
    expect(
      askProtocol({
        anomalies: [
          {
            kind: 'no-effect',
            tier: 'absence-derived',
            claim: 'the action was delivered',
            counter: 'no channel recorded anything',
            between: [ProtocolChannel.NET, ProtocolChannel.UI],
            evidence: [],
          },
        ],
      }),
    ).toBe(Verdict.UNKNOWN);
    expect(
      decideVerified({
        pass: true,
        honesty: CLEAN,
        contradictions: [{ kind: ContradictionKind.ACTION_HAD_NO_EFFECT }],
      }).verified,
    ).toBe(Verified.UNKNOWN);
  });

  /**
   * Two situations that look identical and are not, which is what writing this test established.
   *
   * The first attempt mapped Reticle's `settled: false` onto the protocol's
   * `closedBy: budget-exhausted`, and they disagreed — Reticle said `yes`, the specification said
   * `unknown`. The specification was not wrong and neither was Reticle: **"the verifier gave up
   * waiting" and "this realm cannot measure quiescence" are different facts**, and the mapping
   * had flattened them.
   *
   * The distinction is not academic here. A hidden tab never fires the animation frame `settled`
   * is read from, and a hidden tab is the NORMAL state for agent-driven verification — so treating
   * an unmeasurable settle signal as a give-up would make every backgrounded application
   * permanently unprovable. In protocol terms that is a blind spot on `time`, non-impeaching for a
   * claim that reads `net`; it is not a window that ran out of budget.
   */
  it('both refuse to prove when the verifier actually gave up waiting', () => {
    expect(askProtocol({ closedBy: CloseCondition.BUDGET_EXHAUSTED })).toBe(Verdict.UNKNOWN);
    expect(
      decideVerified({
        pass: true,
        honesty: CLEAN,
        contradictions: [{ kind: ContradictionKind.REQUEST_NEVER_SETTLED }],
      }).verified,
    ).toBe(Verified.UNKNOWN);
  });

  it('both still prove when only the settle SIGNAL was unavailable', () => {
    const unmeasurable = adjudicate({
      claim: {
        id: 'c1',
        statement: 'the thing happened',
        declaredAt: Declaration.BEFORE_ACTION,
        assertions: [
          { id: 'a1', predicate: {}, reads: 'the thing', channels: [ProtocolChannel.NET] },
        ],
      },
      window: {
        id: 'w1',
        openedAt: 0,
        closedAt: 10,
        budgetMs: 8000,
        closes: CloseCondition.QUIESCENCE,
        closedBy: CloseCondition.QUIESCENCE,
        subject: SUBJECT,
      },
      channels: protocolChannels([ProtocolChannel.NET, ProtocolChannel.UI]),
      evidence: [
        {
          observation: {
            id: 'e1',
            window: 'w1',
            channel: ProtocolChannel.NET,
            at: 5,
            value: {},
            summary: 'a request went out and came back',
          },
          provenance: {
            class: ProvenanceClass.OBSERVED,
            source: 'sdk',
            method: 'patched fetch',
            subject: SUBJECT,
            at: 5,
          },
          independence: CHANNEL_DEFAULTS[ProtocolChannel.NET].independence,
          grade: Grade.CONSEQUENCE,
        },
      ],
      coverage: {
        window: 'w1',
        observed: [ProtocolChannel.NET, ProtocolChannel.UI],
        blindSpots: [
          {
            kind: 'channel-unobserved',
            channel: ProtocolChannel.TIME,
            detail: 'the tab is hidden, so no frame is flushed and quiescence cannot be measured',
            // The claim reads `net`. Marking this impeaching would make a backgrounded page
            // permanently unprovable, which is the direction that costs the most.
            impeaching: false,
          },
        ],
      },
      anomalies: [],
      assertionsHeld: true,
    }).verdict;
    expect(unmeasurable).toBe(Verdict.YES);
    expect(decideVerified({ pass: true, honesty: { ...CLEAN, settled: false } }).verified).toBe(
      Verified.YES,
    );
  });

  it('both keep no-fault behind a cleanly closed window', () => {
    // The property that stops "nothing was wrong" becoming a green-forever button.
    expect(
      adjudicate({
        claim: {
          id: 'c1',
          statement: 'nothing declared',
          declaredAt: Declaration.BEFORE_ACTION,
          assertions: [],
        },
        window: {
          id: 'w1',
          openedAt: 0,
          closedAt: 10,
          budgetMs: 8000,
          closes: CloseCondition.QUIESCENCE,
          closedBy: CloseCondition.BUDGET_EXHAUSTED,
          subject: SUBJECT,
        },
        channels: protocolChannels([ProtocolChannel.NET]),
        evidence: [],
        coverage: { window: 'w1', observed: [ProtocolChannel.NET], blindSpots: [] },
        anomalies: [],
        assertionsHeld: undefined,
      }).verdict,
    ).toBe(Verdict.UNKNOWN);
    expect(
      decideVerified({
        honesty: { ...CLEAN, settled: false },
        unsettled: { waitedFor: 'the page to go idle', stillInFlight: ['POST /orders'] },
        contradictions: [{ kind: ContradictionKind.REQUEST_NEVER_SETTLED }],
      }).verified,
    ).not.toBe(Verified.NO_FAULT);
  });
});

describe('where they differ, and why', () => {
  /**
   * The protocol enforces pre-registration as a HARD clause; Reticle treats it as a strengthener.
   *
   * `adjudicate` refuses to prove a claim declared after the action — anything that happened can
   * be described as what you meant. Reticle's `declaredConsequence` instead lets a pre-registered
   * claim OVERRULE two clauses that would otherwise downgrade it, and an ordinary assertion still
   * reaches `yes` on its own evidence.
   *
   * Reticle is the more permissive of the two, so this is a real divergence and worth stating
   * rather than hiding: an assertion written after the fact is `yes` here and `unknown` under the
   * specification. Closing it means every existing assertion has to declare when it was written,
   * which is a migration and not a bug fix — so it is recorded, deliberately, as a known gap
   * rather than quietly reconciled in a test.
   */
  it('the protocol refuses to prove a claim declared after the action, and Reticle does not', () => {
    expect(askProtocol({ declaredAt: Declaration.AFTER_ACTION })).toBe(Verdict.UNKNOWN);
    expect(decideVerified({ pass: true, honesty: CLEAN }).verified).toBe(Verified.YES);
  });

  /**
   * The second divergence, and the one that matters most.
   *
   * Clause 9 is the specification's central claim: *nothing independent of the action supports
   * this at consequence grade; the subject agreeing with itself is not evidence that it acted.*
   * Reticle's grade ladder has the same idea — `presence` is its weakest rung — and stops short
   * of the same conclusion: a passing assertion at `presence` is `yes`, with
   * `verifiedReason: proved`.
   *
   * So an app whose only evidence is its own screen is proved here and unproved under the
   * specification. Permissive again, like the declaration gap, and on the clause the whole
   * protocol is built around.
   *
   * **This set did not compare clause 9 until now**, and the meta-test below used to say this
   * was "the only divergence" while the case that would have contradicted it was missing. That
   * is the failure mode a parity test exists to prevent, committed by the parity test.
   *
   * Recorded, not reconciled, on the same reasoning as the declaration gap: turning a
   * presence-grade `yes` into `unknown` makes the product stricter, and a false NEGATIVE sends
   * an agent back to redo work that already succeeded. That is a product decision with a
   * measurement behind it, not something to change inside a parity test.
   */
  it('the protocol will not prove on presence alone, and Reticle will', () => {
    expect(askProtocol({ grade: Grade.PRESENCE })).toBe(Verdict.UNKNOWN);
    expect(
      decideVerified({
        pass: true,
        honesty: { ...CLEAN, grade: HonestyGrade.PRESENCE },
        declaredConsequence: true,
      }).verified,
    ).toBe(Verified.YES);
  });

  /**
   * The third divergence, and the one where Reticle's position is the more considered.
   *
   * Clause 6 withholds a proof when a blind spot falls on a channel the claim READS -- a
   * targeted test. Reticle's nearest concept is coarser: `coverage.partial`, which is true for a
   * gap anywhere, and which `verified.ts` deliberately does not downgrade on, on the stated
   * reasoning that a gap elsewhere "does not by itself make a graded, clean, uncontradicted pass
   * untrustworthy". It discloses instead: the `because` says coverage was PARTIAL rather than
   * claiming a clean capture.
   *
   * So the two agree wherever the gap is off the claim's channels, and differ where it is on
   * them: unproved under the specification, proved-with-a-caveat here. Permissive a third time.
   *
   * Worth being precise about, because "Reticle fails to impeach" would misread a decision
   * somebody made on purpose and wrote down. What Reticle lacks is not the judgement but the
   * TARGETING -- it has no notion of which channels a claim reads, so it cannot ask the narrower
   * question at all, and the coarse one it can ask was measured too noisy to gate on.
   */
  it("the protocol withholds a proof on a gap in the claim's own channel, and Reticle discloses it", () => {
    expect(askProtocol({ impeachedOn: ProtocolChannel.NET })).toBe(Verdict.UNKNOWN);
    const reticle = decideVerified({
      pass: true,
      honesty: { ...CLEAN, coverage: { partial: true } },
      declaredConsequence: true,
    });
    expect(reticle.verified).toBe(Verified.YES);
    // The disclosure is the half that keeps this defensible rather than merely permissive.
    expect(reticle.because).toContain('PARTIAL');
  });

  it('has exactly three divergences, all in the permissive direction', () => {
    // A parity test's real job is to notice when this stops being true, and the previous version
    // of this test could not: it re-ran one assertion and called the answer "the only
    // divergence", while clause 9 -- the second one -- was not in the compared set at all.
    //
    // All three are Reticle proving something the specification leaves unproved. Neither is Reticle
    // convicting an application the specification would acquit, which is the direction that
    // would matter more, and this asserts that too.
    const divergences = [
      askProtocol({ declaredAt: Declaration.AFTER_ACTION }),
      askProtocol({ grade: Grade.PRESENCE }),
      askProtocol({ impeachedOn: ProtocolChannel.NET }),
    ];
    expect(divergences).toEqual([Verdict.UNKNOWN, Verdict.UNKNOWN, Verdict.UNKNOWN]);
    expect(divergences.includes(Verdict.NO)).toBe(false);
  });
});

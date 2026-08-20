import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';

type VerifiedVerdictInput = Parameters<typeof decideVerified>[0];
import { HonestyGrade, type HonestyBlock } from './honesty.js';

const clean = (grade: HonestyGrade = HonestyGrade.SIGNAL): HonestyBlock => ({
  grade,
  coverage: { partial: false },
  integrity: { clean: true, issues: [] },
});

const dirty = (...issues: string[]): HonestyBlock => ({
  grade: HonestyGrade.SIGNAL,
  coverage: { partial: false },
  integrity: { clean: false, issues },
});

/**
 * `202 Accepted` is HTTP's only word for "no outcome yet".
 *
 * Measured on a logistics console with server-side reconciliation: a dispatch answered 202, the row
 * optimistically rendered "dispatched", the page settled, every channel agreed — and the server
 * REVERTED it to `held` 1.2s later. The verdict was not wrong about what it saw; it was early, and
 * folding 202 into the 2xx success band is what let it be early silently.
 */
describe('a 202 means the outcome does not exist yet', () => {
  const clean = {
    grade: HonestyGrade.STATE,
    integrity: { clean: true, issues: [] },
  } as unknown as Parameters<typeof decideVerified>[0]['honesty'];

  it('is UNKNOWN, not yes, when a write is still being processed', () => {
    const r = decideVerified({ pass: true, honesty: clean, settled: true, outcomePending: true });
    expect(r.verified).toBe(Verified.UNKNOWN);
    expect(r.because).toContain('202');
  });

  it('is UNKNOWN rather than NO — nothing has failed yet', () => {
    // Reporting a failure that has not happened is its own false report, in the other direction.
    expect(
      decideVerified({ pass: true, honesty: clean, settled: true, outcomePending: true }).verified,
    ).not.toBe(Verified.NO);
  });

  it('a real failure still outranks it', () => {
    const r = decideVerified({ pass: false, honesty: clean, settled: true, outcomePending: true });
    expect(r.verified).toBe(Verified.NO);
  });

  it('leaves an ordinary synchronous action green', () => {
    expect(decideVerified({ pass: true, honesty: clean, settled: true }).verified).toBe(
      Verified.YES,
    );
  });
});

describe('decideVerified — one answer from eight dimensions', () => {
  it('says YES for a graded, clean, settled, uncontradicted pass', () => {
    const v = decideVerified({ pass: true, honesty: clean(), settled: true });
    expect(v.verified).toBe(Verified.YES);
    expect(v.because).toContain('signal');
  });

  it('says NO when the declared consequence did not hold', () => {
    expect(decideVerified({ pass: false, honesty: clean(), settled: true }).verified).toBe(
      Verified.NO,
    );
  });
});

/**
 * The case the product exists for. Measured on the bench app: `ui-advanced-request-failed` arrived
 * with verdict.pass true and every other channel agreeing the action was fine. If `pass` outranked
 * the contradiction, the single field an agent reads would report the very false green being
 * detected — so this inversion is the most important assertion in the file.
 */
describe('a contradiction outranks a passing assertion', () => {
  it('says NO when channels disagree even though the assertion passed', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'ui-advanced-request-failed' }],
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.because).toContain('ui-advanced-request-failed');
  });

  it('names every disagreeing channel, so the agent knows where to look', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'duplicate-request' }, { kind: 'response-ignored' }],
    });
    expect(v.because).toContain('duplicate-request');
    expect(v.because).toContain('response-ignored');
  });
});

/**
 * UNKNOWN must never collapse into NO. "I could not see" and "it is broken" send an agent in
 * opposite directions — look again with better coverage, versus go change code. Merging them
 * manufactures false alarms in one direction and false confidence in the other.
 */
describe('UNKNOWN is a distinct answer, never folded into NO', () => {
  it('is UNKNOWN — not NO — when the capture was not clean', () => {
    const v = decideVerified({ pass: true, honesty: dirty('capture truncated'), settled: true });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verified).not.toBe(Verified.NO);
    expect(v.because).toContain('capture truncated');
  });

  it('is UNKNOWN when nothing was asserted at a real grade (a vacuous green)', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(HonestyGrade.NONE),
      settled: true,
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.because).toMatch(/proves nothing/);
  });

  it('is UNKNOWN when the page never settled', () => {
    const v = decideVerified({ pass: true, honesty: clean(), settled: false });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.because).toMatch(/never settled/);
  });

  /** The exact signal that stumped a real drive: settled:false with no other fault. */
  it('resolves the settle-timeout ambiguity that previously had no answer', () => {
    expect(decideVerified({ pass: true, honesty: clean(), settled: false }).verified).toBe(
      Verified.UNKNOWN,
    );
  });
});

/**
 * The false RED. Every other clause in this rule is tuned against claiming more than was observed;
 * this one was the hole in the other direction.
 *
 * Measured twice, on a healthy app: reload the page 300ms into a wait and the verdict came back
 *
 *   verified:"no", verifiedReason:"assertion_failed",
 *   because:"the declared consequence did not hold", source:"src/components/Counter.tsx:18"
 *
 * The app was fine. The observer left. An agent reading that goes and edits Counter.tsx.
 */
describe('a lost connection is not a failed assertion', () => {
  it('is UNKNOWN, not NO, when the tab went away mid-wait', () => {
    const v = decideVerified({
      pass: false,
      observationLost: true,
      honesty: clean(),
      settled: true,
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verified).not.toBe(Verified.NO);
    expect(v.verifiedReason).toBe(VerifiedReason.OBSERVATION_LOST);
  });

  it('says the tab disconnected, and never that the consequence did not hold', () => {
    const v = decideVerified({
      pass: false,
      observationLost: true,
      honesty: clean(),
      settled: true,
    });
    expect(v.because).toMatch(/disconnected/);
    // The specific sentence that sent an agent to the wrong file.
    expect(v.because).not.toMatch(/did not hold/);
  });

  it('leaves a GENUINE failure alone — the flag is the only difference', () => {
    // Identical inputs but for `observationLost`. If this ever goes UNKNOWN, the fix has swallowed
    // real failures, which is far worse than the bug it replaced.
    const v = decideVerified({ pass: false, honesty: clean(), settled: true });
    expect(v.verified).toBe(Verified.NO);
    expect(v.verifiedReason).toBe(VerifiedReason.ASSERTION_FAILED);
  });

  it('an assertion nobody could EVALUATE still outranks one nobody could OBSERVE', () => {
    // Both are "we cannot say", and `inconclusive` names the more specific cause (the agent's own
    // call), so it must keep leading.
    const v = decideVerified({
      pass: false,
      observationLost: true,
      inconclusive: 'no store named cart',
      honesty: clean(),
      settled: true,
    });
    expect(v.verifiedReason).toBe(VerifiedReason.INCONCLUSIVE);
  });
});

describe('precedence between competing faults', () => {
  it('reports the failed assertion first, as the most actionable fact', () => {
    const v = decideVerified({
      pass: false,
      honesty: dirty('capture truncated'),
      contradictions: [{ kind: 'duplicate-request' }],
      settled: false,
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.because).toContain('did not hold');
  });

  it('prefers a contradiction over a dirty capture: evidence AGAINST beats absence of evidence', () => {
    const v = decideVerified({
      pass: true,
      honesty: dirty('capture truncated'),
      contradictions: [{ kind: 'signal-contradicted' }],
      settled: true,
    });
    expect(v.verified).toBe(Verified.NO);
  });

  /**
   * The same rule as the dirty-capture case above, applied to the other absence-of-evidence verdict.
   *
   * `alreadyTrue` says the assertion proves nothing about the action; a contradiction says a channel
   * observed the action going WRONG. Both can hold at once — assert `{ text: 'Saved' }` that was
   * already on screen while the write 500s — and ordering alreadyTrue first downgraded a detected
   * false green from NO to UNKNOWN, which reads as "assert something else" rather than "this is
   * broken". Evidence AGAINST beats absence of evidence, whichever absence it is.
   */
  it('prefers a contradiction over an already-true assertion', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(),
      alreadyTrue: true,
      contradictions: [{ kind: 'ui-advanced-request-failed' }],
      settled: true,
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.because).toContain('disagree');
  });

  /** Partial coverage is a caveat carried in `honesty.coverage`, not grounds to withhold a verdict. */
  it('still says YES under partial coverage when nothing else is wrong', () => {
    const v = decideVerified({
      pass: true,
      honesty: { ...clean(), coverage: { partial: true } },
      settled: true,
    });
    expect(v.verified).toBe(Verified.YES);
  });

  it('treats an action that declared no consequence as ungraded, not as a pass', () => {
    const v = decideVerified({ honesty: clean(HonestyGrade.NONE), settled: true });
    expect(v.verified).toBe(Verified.UNKNOWN);
  });
});

/**
 * `dropped` is CUMULATIVE for the session, so reading it raw asks "has this session ever lost an
 * event" rather than "was this action's window complete". Measured on the Next.js demo at
 * `dropped: 51`: every action's own window was intact, and every one still reported an untrustworthy
 * capture — which pinned `verified` to `unknown` permanently, silently destroying the field's value
 * on exactly the long-running sessions it matters most for.
 *
 * The rule below is unchanged; what changed is the input. These pin the consequence so the scoping
 * cannot regress into a session-lifetime read again.
 */
describe('a stale eviction from earlier in the session must not condemn later actions', () => {
  it('is YES when nothing was dropped DURING this action', () => {
    // dropped-during is false → integrity clean, even on a session that evicted plenty earlier.
    const v = decideVerified({ pass: true, honesty: clean(), settled: true });
    expect(v.verified).toBe(Verified.YES);
  });

  it('is UNKNOWN when the buffer lost events during THIS action', () => {
    const v = decideVerified({
      pass: true,
      honesty: dirty('capture truncated'),
      settled: true,
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.because).toContain('capture truncated');
  });
});

/**
 * `verified` has three values and this rule has twelve clauses, so the verdict alone throws away the
 * only thing that says WHO has to act. Measured in a real capture: `unknown` + `passed: false` was
 * indistinguishable between "Reticle caught a real bug", "the agent wrote a bad predicate" and
 * "Reticle itself could not see", and `no` collapsed "channels disagree" into "the agent's predicate
 * failed". Seven distinct causes reached the wire as two payloads.
 *
 * The pair of checks below is what keeps the enum honest in BOTH directions: a clause without a
 * member cannot compile, and a member without a clause fails here. Neither list is hand-maintained
 * against the other.
 */
describe('every verdict names the clause that decided it', () => {
  const branches: Record<VerifiedReason, VerifiedVerdictInput> = {
    [VerifiedReason.INCONCLUSIVE]: { pass: true, honesty: clean(), inconclusive: 'no store named' },
    [VerifiedReason.ASSERTION_FAILED]: { pass: false, honesty: clean(), settled: true },
    // Same `pass: false` as the row above — the ONLY difference is that the observer left. Those two
    // rows sitting next to each other is the point: for a long time they produced the same verdict.
    [VerifiedReason.OBSERVATION_LOST]: {
      pass: false,
      honesty: clean(),
      settled: true,
      observationLost: true,
    },
    [VerifiedReason.CONTRADICTED]: {
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'signal-contradicted' }],
    },
    [VerifiedReason.ALREADY_TRUE]: {
      pass: true,
      honesty: clean(),
      settled: true,
      alreadyTrue: true,
    },
    [VerifiedReason.UNCLEAN_CAPTURE]: {
      pass: true,
      honesty: dirty('capture truncated'),
      settled: true,
    },
    [VerifiedReason.VACUOUS_GRADE]: { honesty: clean(HonestyGrade.NONE), settled: true },
    [VerifiedReason.OUTCOME_PENDING]: {
      pass: true,
      honesty: clean(),
      settled: true,
      outcomePending: true,
    },
    [VerifiedReason.OUTCOME_UNREAD]: {
      pass: true,
      honesty: clean(),
      settled: true,
      outcomeUnread: ['POST /api/bulk-hold'],
    },
    [VerifiedReason.UNSETTLED]: { pass: true, honesty: clean(), settled: false },
    [VerifiedReason.EVIDENCE_INCOMPLETE]: {
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'duplicate-request' }],
    },
    [VerifiedReason.PROVED]: { pass: true, honesty: clean(), settled: true },
    [VerifiedReason.ABSENCE_BLIND_SPOT]: {
      pass: true,
      honesty: clean(),
      settled: true,
      absenceBlindSpot: 'the absence target was in an unobserved region',
    },
  };

  it.each(Object.entries(branches))('reports %s', (expected, inputs) => {
    expect(decideVerified(inputs).verifiedReason).toBe(expected);
  });

  /**
   * A member nobody produces is a value a dashboard will wait for forever. This is the half a typed
   * record cannot catch: `Record<VerifiedReason, …>` forces a row per member, but only running the
   * rule proves the row actually reaches that clause.
   */
  it('has no member that no clause produces', () => {
    const produced = new Set(
      Object.values(branches).map((inputs) => decideVerified(inputs).verifiedReason),
    );
    expect([...Object.values(VerifiedReason)].filter((r) => !produced.has(r))).toEqual([]);
  });
});

/**
 * A caveat an agent cannot locate is one it learns to skip. Every other clause in the rule names the
 * evidence that decided it; this one described a shape ("a write returned 2xx…") and named no write,
 * so on any page making more than one call the next move was a guess.
 */
describe('an unread outcome names the write that decided the verdict', () => {
  it('puts the method and url in the sentence', () => {
    const decision = decideVerified({
      pass: true,
      honesty: clean(),
      settled: true,
      outcomeUnread: ['POST /api/bulk-hold', 'PUT /api/shipments/9'],
    });
    expect(decision.verifiedReason).toBe(VerifiedReason.OUTCOME_UNREAD);
    expect(decision.because).toContain('POST /api/bulk-hold');
    expect(decision.because).toContain('PUT /api/shipments/9');
  });

  // Negative control: an empty list is not a caveat. Nothing went unread, so nothing is withheld.
  it('does not downgrade when no write went unread', () => {
    expect(
      decideVerified({ pass: true, honesty: clean(), settled: true, outcomeUnread: [] }).verified,
    ).toBe(Verified.YES);
  });
});

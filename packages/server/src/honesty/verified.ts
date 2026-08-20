import {
  ContradictionKind,
  MUTATING_METHODS,
  Verified,
  VerifiedReason,
  isAbsenceDerived,
} from '@reticlehq/core';
import { HonestyGrade, type HonestyBlock } from './honesty.js';
import { unsettledBecause, type UnsettledWindow } from './unsettled.js';

/**
 * The decision rule: eight trust dimensions in, one answer out.
 *
 * Everything needed to judge an action already travelled on the result — the assertion verdict, the
 * grade it proved, whether the capture was clean, whether the page settled, whether any channel
 * disagreed. What was missing was the RULE, so every agent had to invent one, and inventing it under
 * uncertainty is exactly where a confident wrong answer comes from.
 *
 * Ordering is deliberate, because the first matching clause also writes `because`, and the reader
 * should be told the most actionable fact rather than the first true one.
 */

interface VerifiedInputs {
  /** Did the declared consequence hold? Undefined when the action declared none. */
  pass?: boolean;
  /**
   * The wait ended because the TAB went away, not because the app did anything.
   *
   * A structured flag rather than a match on `failureReason`, which is free prose everywhere else it
   * is produced and describes what the APP did. A string test here would silently reclassify the
   * next app-side reason that happened to mention a disconnect, which is the same
   * confidently-wrong-by-accident this clause exists to remove.
   */
  observationLost?: boolean;
  honesty: HonestyBlock;
  /**
   * Set when the assertion could not be EVALUATED at all — an under-specified call, or nothing
   * instrumented to read. Carries the sentence naming what is missing.
   */
  inconclusive?: string;
  /**
   * The declared consequence was ALREADY TRUE before the action ran, so its holding afterwards says
   * nothing about the action. Only meaningful for predicates that read live DOM state — event-based
   * ones are floored at the act's cursor and cannot be satisfied by the past.
   */
  alreadyTrue?: boolean;
  /** Cross-channel disagreements found in the action's window. */
  contradictions?: readonly { kind: string }[];
  /** Did a real frame flush before the wait gave up? */
  settled?: boolean;
  /**
   * The caller NAMED the expected consequence before acting — an `until`/`predicate` of its own,
   * rather than the default "wait for the page to go idle".
   *
   * This is the epistemic core of the tool: a declaration made before the action cannot be
   * rationalised after it. When such a declaration HOLDS, settlement is corroboration, not a veto —
   * so the two clauses that answer "the app had not gone quiet" step aside for it. Measured in the
   * field on three different apps: the expected text was on screen, the write returned 204, the
   * nested verdict passed with evidence, and the verdict was `unknown` because the SPA polls, or
   * because the tab was hidden and a hidden tab never fires the animation frame `settled` is read
   * from. A hidden tab is the NORMAL state for agent-driven verification, so a signal that is always
   * false there cannot be a precondition for a verdict.
   *
   * Narrow on purpose. It steps aside for settlement ONLY: an absence-derived finding about what the
   * action DID — a duplicate write, a dead control, a route that rendered nothing, a response
   * nothing consumed — still downgrades, and every positively OBSERVED contradiction still wins
   * outright. Fixing a false negative must not open a path to a false positive.
   */
  declaredConsequence?: boolean;
  /**
   * A write in this window answered `202 Accepted` — the server took the request and has NOT
   * finished processing it.
   */
  outcomePending?: boolean;
  /**
   * Writes in this window that returned 2xx with a payload that was never recorded, as "METHOD url",
   * so their outcome was never read. See `unreadWriteLabels` — the status line describes the
   * transport, not the result.
   *
   * The LABELS rather than a flag: every other clause names the evidence that decided it, and this
   * one named nothing, so an agent holding the caveat could not tell which call it was about.
   * Empty means nothing went unread.
   */
  outcomeUnread?: readonly string[];
  /**
   * What the wait was for and what the window held when it ended — read ONLY by the two clauses that
   * answer UNSETTLED, which is the commonest reason a verdict comes back `unknown` and was also the
   * least actionable. Optional: without it those clauses say exactly what they said before.
   */
  unsettled?: UnsettledWindow;
  /** A passing absence assertion targeted a region that the current capture could not observe. */
  absenceBlindSpot?: string;
}

interface VerifiedVerdict {
  verified: Verified;
  /**
   * WHICH clause below decided this, as a closed enum. `verified` has three values and this rule has
   * eleven clauses, so the verdict alone collapses opposite facts — "Reticle caught a real bug", "the
   * agent wrote a bad predicate" and "Reticle could not see" all arrived as one string. Named here,
   * beside the sentence, so the vocabulary cannot drift from the branches that produce it.
   */
  verifiedReason: VerifiedReason;
  /** One sentence naming the deciding evidence — never a restatement of the field. */
  because: string;
}

export function decideVerified(inputs: VerifiedInputs): VerifiedVerdict {
  const { pass, honesty, contradictions = [], settled, outcomePending, outcomeUnread } = inputs;
  /** The caller named a consequence before acting and it held — see `declaredConsequence`. */
  const declaredHeld = true === inputs.declaredConsequence && true === pass;

  // Ahead of the failure clause, because a failure is only the most actionable fact when there WAS
  // one. An assertion nobody could evaluate is not a defect in the app, and calling it one was
  // putting the agent's own malformed calls into the bug count.
  if (inputs.inconclusive !== undefined) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.INCONCLUSIVE,
      because: `the assertion could not be evaluated: ${inputs.inconclusive}`,
    };
  }

  // ABOVE the failure clause, because a wait that ended when the tab vanished did not fail — it was
  // never finished. `waitForPredicate` reports that as `pass: false`, and taking it at face value
  // made Reticle blame the app, by file and line, for its own lost connection. Measured twice: a
  // reload 300ms into a wait returned `verified:"no" / assertion_failed` against a healthy Counter.
  //
  // UNKNOWN, for the same reason `unclean_capture` is: the evidence is ABSENT, not negative.
  if (true === inputs.observationLost) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.OBSERVATION_LOST,
      because:
        'the tab disconnected while this action was being observed, so its outcome was never ' +
        'seen — this says nothing about the app. Call reticle_sessions for the current session ' +
        '(a reloaded tab keeps its id; a closed one is gone) and repeat the action if it is safe ' +
        'to repeat',
    };
  }

  // A failed assertion is the most actionable fact there is; it leads — including over
  // `alreadyTrue`, because a condition that held before AND fails now is a real regression.
  if (false === pass) {
    return {
      verified: Verified.NO,
      verifiedReason: VerifiedReason.ASSERTION_FAILED,
      because: 'the declared consequence did not hold',
    };
  }

  // A contradiction outranks a passing assertion, and that inversion is the whole point: the case
  // this product exists to catch is a green assertion sitting on top of a failed write. Measured on
  // the bench app — `ui-advanced-request-failed` arrived with verdict.pass true and every other
  // channel agreeing. Letting `pass` win there would report exactly the false green being detected.
  // ...but ONLY for contradictions we positively OBSERVED. A kind inferred from the absence of
  // evidence — the request had not settled, the response had not been applied yet — is a statement
  // about when we stopped looking, not about whether the action worked, and the window closes the
  // moment the predicate first passes. Reproduced on the bench app: `auth:granted` fired with
  // matching data, state changed, the token was stored, the capture was clean and the grade was
  // `signal`, and the verdict was still NO because one POST was in flight. That inverts the grade
  // hierarchy — a timing observation beat a consequence observation — and it is the shape of half of
  // every `no` verdict in the field. See ABSENCE_DERIVED_CONTRADICTIONS for why a false negative
  // costs more than it looks: it makes an agent redo work that succeeded, or stop believing the
  // verdict channel, which is the product.
  const observed = contradictions.filter((c) => !isAbsenceDerived(c.kind));
  if (observed.length > 0) {
    const kinds = observed.map((c) => c.kind).join(', ');
    return {
      verified: Verified.NO,
      verifiedReason: VerifiedReason.CONTRADICTED,
      because: `channels disagree about this action (${kinds}) even though the assertion passed`,
    };
  }
  // Absence-derived only: report it, do not assert failure. UNKNOWN is the honest answer — Reticle
  // drove the app and could not yet tell. The finding still rides out in `contradictions`, so an
  // agent that wants to wait and re-check has everything it needs.
  //
  // ...except when the only finding is that a READ had not come back AND the caller declared the
  // consequence that did. `request-never-settled` is a statement about when we stopped looking; the
  // declaration is a statement about what was supposed to happen, made before it could. On a page
  // that polls, the first is permanently true and vetoed every verdict the second earned.
  //
  // An open WRITE is the exception to the exception, and it is where the false-green defence lives:
  // "the toast said Saved while the POST was still open" is the archetype this product exists to
  // catch, and its outcome genuinely does not exist yet. A poll or a prefetch left hanging says
  // nothing about the action; an unfinished mutation says the answer is not in yet. Read off the
  // labels the window already carries — and when there are no labels to read, nothing is softened.
  const openWrite = (inputs.unsettled?.stillInFlight ?? []).some((label) =>
    MUTATING_METHODS.includes((label.split(' ')[0] ?? '').toUpperCase()),
  );
  const settlementOnly =
    declaredHeld &&
    inputs.unsettled !== undefined &&
    !openWrite &&
    contradictions.every((c) => c.kind === ContradictionKind.REQUEST_NEVER_SETTLED);
  if (contradictions.length > 0 && !settlementOnly) {
    const kinds = contradictions.map((c) => c.kind).join(', ');
    return {
      verified: Verified.UNKNOWN,
      // NOT `unsettled`: this clause fires whether or not the page went idle, and naming it after
      // idle produced verdicts that read `unsettled` beside `settled: true`.
      verifiedReason: VerifiedReason.EVIDENCE_INCOMPLETE,
      because: unsettledBecause(
        `the assertion held, but this window closed before the app finished (${kinds})`,
        inputs.unsettled,
      ),
    };
  }

  // An absence assertion over a region Reticle cannot observe is not disproved, but it is not proved
  // either. This is narrower than general partial coverage: the target itself is scoped to the blind
  // region, so the DOM result cannot answer the question the caller asked.
  if (inputs.absenceBlindSpot !== undefined) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.ABSENCE_BLIND_SPOT,
      because: inputs.absenceBlindSpot,
    };
  }

  // Below the contradiction clause, and for the same reason a contradiction outranks a dirty
  // capture: evidence AGAINST beats absence of evidence, whichever absence it is. Both can hold at
  // once — assert `{ text: 'Saved' }` that was already on screen while the write 500s — and ordering
  // this first downgraded a DETECTED false green from NO to UNKNOWN, which reads as "assert
  // something else" rather than "this is broken".
  //
  // A green that was already green before the action is not evidence about the action. Measured in
  // the field: a click asserted with `{ text: 'Parallel Routes' }` returned verified "yes" in 478ms
  // with routeChanges 0, because the text was the nav link already on screen — the real navigation
  // landed 1.8s later. UNKNOWN rather than NO on purpose: the app may well be fine, and reporting a
  // failure we did not observe would be its own false claim.
  if (true === inputs.alreadyTrue) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.ALREADY_TRUE,
      because:
        'the declared consequence was already true before this action, so it proves nothing about it — assert something the action CHANGES (a signal, a request, a route, or store state)',
    };
  }

  // Dirty capture is NOT failure. The layer could not see part of the window, so any green is a
  // statement about what it happened to observe — which is precisely the thing that must not be
  // reported as proof.
  if (!honesty.integrity.clean) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.UNCLEAN_CAPTURE,
      because: `capture was not clean (${honesty.integrity.issues.join('; ')}), so a green here would only describe what was observed`,
    };
  }

  // A vacuous green: nothing was actually proved. Grade NONE means no signal, no request, no state
  // change and no element was pinned — the assertion could not have failed, which makes passing it
  // evidence of nothing.
  if (honesty.grade === HonestyGrade.NONE) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.VACUOUS_GRADE,
      because:
        'nothing was asserted at a real grade, so passing proves nothing — assert a signal, request, or state path',
    };
  }

  // A `202 Accepted` is the server saying, in the only word HTTP has for it, that the outcome does
  // not exist yet. Treating 2xx as success makes every asynchronous workflow verifiable at exactly
  // the moment nothing has been decided.
  //
  // Measured on a logistics console with server-side reconciliation: a dispatch answered 202, the row
  // optimistically rendered "dispatched", the page settled, and the verdict came back `yes` — then
  // the server REVERTED it to `held` 1.2s later. Every channel agreed, and every channel was early.
  // UNKNOWN rather than NO: nothing has failed, and saying it has would be its own false report.
  if (true === outcomePending) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.OUTCOME_PENDING,
      because:
        'a write returned 202 Accepted, so the server has not finished processing it — this window cannot contain the outcome; re-check once it reconciles',
    };
  }

  // A write answered 2xx and its payload went unread, so the one channel that could contradict the
  // screen was never opened. Reporting `yes` here means "no channel disagreed" — true only because a
  // channel was closed. Measured on a shipments console: `POST /api/bulk-hold` → 200 with three of
  // nine items failed inside the body, banner reading "9 shipments held", verdict `yes`.
  //
  // UNKNOWN, not NO: nothing is known to have failed. The remedy is in the sentence, because an
  // agent that cannot act on a caveat will learn to skip it.
  if (outcomeUnread !== undefined && outcomeUnread.length > 0) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.OUTCOME_UNREAD,
      because:
        `a write returned 2xx with a response body that was never recorded (${outcomeUnread.join('; ')}), so its outcome is unread` +
        ' — a 200 describes the transport, not the result (a batch reports per-item failures in the body, and every GraphQL error is a 200). Enable it where your app calls connect(): `reticle.connect({ captureNetworkBodies: true })`, then re-run',
    };
  }

  // Never settled: the page may still be moving, so the observation window may have closed early.
  //
  // Skipped when the caller DECLARED the consequence and it held. `settled` here is "a real
  // animation frame fired within the budget", which a hidden or throttled tab never does — and a
  // hidden tab is the ordinary case for agent-driven verification. It is corroboration; it is not
  // the claim. It is still reported: `honesty.settled` carries the fact, and the sentence below says
  // so in words.
  if (false === settled && !declaredHeld) {
    return {
      verified: Verified.UNKNOWN,
      verifiedReason: VerifiedReason.UNSETTLED,
      because: unsettledBecause(
        'the page never settled, so the reaction window may have closed before the app finished',
        inputs.unsettled,
      ),
    };
  }

  // Partial coverage is a real caveat but not a blocker — it is reported in `honesty.coverage` and
  // does not by itself make a graded, clean, uncontradicted pass untrustworthy.
  //
  // It must not be described as clean, though. This sentence said "over a clean capture" regardless,
  // so a verdict could read `verified: yes ... over a clean capture` directly beside `coverage:
  // partial` — the prose contradicting the evidence block next to it. Whichever a reader believes,
  // one of them lied, and the whole point of this layer is that the sentence can be trusted on its
  // own. Seen on a one-way IPC send: coverage said the outcome was unobservable, `because` said clean.
  // A green that rests on the declaration rather than on idle says so. The page not going quiet is a
  // real fact about the app — a poll, a timer, a throttled tab — and a caller who cares must be able
  // to see it without re-deriving it, so it is stated here and carried in `honesty.settled`.
  const notIdle =
    false === settled
      ? ', though the page never went idle — this rests on the consequence you declared, not on the page going quiet'
      : '';
  return {
    verified: Verified.YES,
    verifiedReason: VerifiedReason.PROVED,
    because:
      true === honesty.coverage?.partial
        ? `assertion held at ${honesty.grade} grade with no channel disagreeing, but coverage was PARTIAL — see \`coverage\` for what went unobserved${notIdle}`
        : `assertion held at ${honesty.grade} grade over a clean capture with no channel disagreeing${notIdle}`,
  };
}

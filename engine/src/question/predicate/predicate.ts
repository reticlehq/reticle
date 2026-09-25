import {
  ElementState,
  PredicateKind,
  THROTTLED_STARVED_NOTE,
  isSameDocument,
} from '@reticlehq/core';

import type { Baseline } from './property.js';

/** Pre-action readings, keyed by the leaf predicate that needs one. See `evaluatePredicate`. */
export type Baselines = ReadonlyMap<Predicate, Baseline>;

import { predicateToExpectedLinks } from './predicate-to-links.js';
import type { ElementQuery, ExpectedLink } from '@reticlehq/core';
import { isAmbient, ambientKeyOf } from '@/window/ambient.js';
import { evalRoute } from './predicate-route.js';
import { describeSuperseded } from './observed-in-window.js';
import { evalElement, withTextProperty } from './predicate-element.js';
import { evalState } from './predicate-state.js';
import {
  PredicateSchema,
  evalNet,
  evalConsole,
  evalAnimation,
  evalSignal,
  evalSettled,
  type Predicate,
  type EvalResult,
} from './predicate-eval.js';

export { PredicateSchema, PredicateKind };
export type { Predicate, EvalResult };
import { withinBudget, type PredicateSession } from './predicate-session.js';
export type { PredicateSession } from './predicate-session.js';

/**
 * A composite result that carries a child's "nobody could evaluate this" up to the verdict rule.
 *
 * `decideVerified` already treats `inconclusive` correctly and does it ahead of the failure clause,
 * so all a composite has to do is stop dropping the field on its way out. `pass` stays false because
 * nothing was proven; what changes is that the verdict reads UNKNOWN rather than blaming the app for
 * a clause the CALL under-specified.
 */
function unreadableComposite(child: EvalResult, evidence: unknown): EvalResult {
  const reason = child.inconclusive ?? 'a sub-predicate could not be evaluated';
  return { pass: false, failureReason: reason, inconclusive: reason, evidence };
}

/**
 * Oracles whose ONLY source of truth is the event window.
 *
 * Element, text and state read the page as it is right now, so supersession cannot reach them. Route
 * is the deliberate omission: it has a second source — where the app is at this moment — and a
 * reload is precisely the case it was given that fallback for, so emptying its window must not take
 * the answer away.
 */
const WINDOW_ONLY_KINDS: ReadonlySet<Predicate['kind']> = new Set([
  PredicateKind.NET,
  PredicateKind.CONSOLE,
  PredicateKind.ANIMATION,
  PredicateKind.SIGNAL,
  PredicateKind.SETTLED,
]);

/** Names the oracle that answered, in the same shape every other `assertion` here uses. */
const SUPERSEDED_ASSERTION = 'window.evidence-superseded';

/** The predicate's own event-time floor, if its kind carries one. */
function predicateSince(predicate: Predicate): number {
  return 'since' in predicate && 'number' === typeof predicate.since ? predicate.since : 0;
}

/**
 * A miss on a throttled tab is not a missing render. The browser has starved the tab, so a timeout
 * there may mean it never ran — which must not look like "the text is absent".
 *
 * Sets `inconclusive` only. The PROSE is already handled one layer up by
 * `annotateStarvedFailure` (session-health.ts), which suffixes the same fact onto the
 * failureReason so the concrete diagnosis still leads; writing it here as well would put the
 * sentence in every throttled failure twice. What was missing was never the sentence — it was the
 * FIELD an agent gates on, so a starved wait graded `assertion-failed` and sent somebody to fix
 * working code.
 *
 * Idempotent, and a more specific `inconclusive` (unreadable locator, superseded window) is never
 * overwritten.
 */
function annotateThrottledMiss(
  session: PredicateSession,
  predicate: Predicate,
  result: EvalResult,
): EvalResult {
  if (result.pass) return result;
  if (result.inconclusive !== undefined) return result;
  const preconditionFailure = session.preconditionFailure?.();
  if (preconditionFailure !== undefined) {
    return { ...result, inconclusive: preconditionFailure };
  }
  if (true !== session.throttled?.()) return result;
  if (decidedByAnAlreadyAnnotatedClause(predicate)) return result;
  if (failureRestsOnSeeing(predicate)) return result;
  return { ...result, inconclusive: THROTTLED_STARVED_NOTE };
}

/**
 * Has this predicate's failure ALREADY been adjudicated, one level down?
 *
 * `allOf`/`anyOf` evaluate their clauses through `evaluatePredicate`, so every clause arrives here
 * first and carries its own verdict on the starved-tab question. Asking again at the composite
 * re-decides it with strictly less information: the composite knows only that SOMETHING failed.
 *
 * A readable `allOf` failure is a clause that failed by having SEEN something, because a clause that
 * failed by NOT seeing is stamped starved before the composite looks (or cleared by
 * `clearStarvedWhenSiblingsSaw` when a sibling proved the tab renders). An `anyOf` reports "no
 * sub-predicate matched" only when every clause failed readably. Without this, an `absent: true`
 * clause that matched 13 elements was graded honestly as a clause and then re-graded `unknown` as an
 * `allOf` of one (#897).
 *
 * `not` is deliberately absent: it fails when its child PASSED, and a passing child is never
 * annotated, so there is nothing decided to defer to. `failureRestsOnSeeing` answers it by flipping.
 */
function decidedByAnAlreadyAnnotatedClause(predicate: Predicate): boolean {
  return PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind;
}

/**
 * Did this arm PROVE the tab rendered?
 *
 * An element predicate that passed did so by finding matches, and nothing about a starved tab
 * conjures elements that were not there. `absent: true` is the exception and the reason this is not
 * simply `result.pass`: that one passes by finding NOTHING, which is precisely the reading a starved
 * tab makes untrustworthy, so it proves the opposite of a render.
 *
 * Composites recurse: a passing `allOf` proves a render if any of its own arms did.
 */
function provesRender(predicate: Predicate, result: EvalResult): boolean {
  if (!result.pass) return false;
  if (PredicateKind.ELEMENT === predicate.kind) return true !== predicate.absent;
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return predicate.predicates.some((p) => provesRender(p, result));
  }
  return false;
}

/**
 * Drop the starved-tab caveat from arms whose SIBLINGS demonstrated that the tab renders.
 *
 * Reported as the most frequent condition in the whole field export (#1004), in its sharpest form:
 * "A negative arm inside `allOf` was graded 'unknown / this tab is throttled and has not rendered'
 * in the SAME evaluation where three sibling arms returned rendered, visible, inViewport elements."
 * A verdict that contradicts its own evidence is worse than either answer on its own.
 *
 * The caveat exists because a negative reading on a starved tab may mean "I could not look". A
 * sibling that found an element is direct proof that looking worked, in this evaluation, on this
 * tab. Keeping the caveat anyway turns a real product failure into `unknown` — which an agent
 * re-drives or walks away from, so the defect it was holding proof of never reaches anybody.
 *
 * Only the throttle note is cleared. An arm that was unreadable for its own reason — an unparseable
 * locator, a superseded window — is still unreadable however well its siblings did.
 */
function clearStarvedWhenSiblingsSaw(
  predicates: readonly Predicate[],
  results: readonly EvalResult[],
): readonly EvalResult[] {
  const rendered = results.some((r, i) => {
    const p = predicates[i];
    return p !== undefined && provesRender(p, r);
  });
  if (!rendered) return results;
  return results.map((r) => {
    if (THROTTLED_STARVED_NOTE !== r.inconclusive) return r;
    const { inconclusive: _dropped, ...rest } = r;
    return rest;
  });
}

/**
 * Does this predicate FAIL by having seen something, rather than by not having seen it?
 *
 * The starved-tab caveat only applies to a negative reading. Throttling can stop the tab rendering,
 * so "I did not find it" may mean "I could not look" — but nothing about a starved tab conjures
 * elements that were not there, so "I found 13 of them" is as true on a throttled tab as anywhere.
 * An `absent: true` predicate inverts exactly that: its failure IS the positive observation.
 *
 * Getting this wrong understated real product failures. An absence assertion that matched a
 * framework debug page's `ProgrammingError` heading came back `unknown`, and `unknown` is what an
 * agent re-drives or walks away from — so the proof it was holding never reached anybody.
 *
 * `not` flips the polarity again, and nests, so this recurses rather than checking one level.
 *
 * A composite reaches here only under a `not` (a bare one is answered by
 * `decidedByAnAlreadyAnnotatedClause`). There the question is whether it could have PASSED by not
 * seeing something, and `some` is the conservative answer: one clause that passes by absence makes
 * the whole pass untrustworthy on a starved tab. An over-cautious `unknown` costs a re-drive, a
 * missing one costs a wrong verdict.
 */
function failureRestsOnSeeing(predicate: Predicate): boolean {
  if (PredicateKind.NOT === predicate.kind) return !failureRestsOnSeeing(predicate.predicate);
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return predicate.predicates.some(failureRestsOnSeeing);
  }
  if ('absent' in predicate && true === predicate.absent) return true;
  // `count: 0` is absence written as arithmetic, and fails the same way: by matching something.
  return 'count' in predicate && 0 === predicate.count;
}

export async function evaluatePredicate(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
  diagnose = true,
  /**
   * The readings taken BEFORE the action, keyed by the leaf that asked for one.
   *
   * Only the relative properties (`changed`/`unchanged`/`increased`/`decreased`) look at it, and a
   * leaf with none evaluates as `inconclusive` rather than false — nothing was compared, so a
   * `false` would blame the app for a reading nobody took. Keyed by the predicate OBJECT because
   * the same parsed tree is evaluated before and after, so identity is exact and needs no path.
   */
  baselines?: Baselines,
): Promise<EvalResult> {
  return annotateThrottledMiss(
    session,
    predicate,
    await evaluatePredicateRaw(session, predicate, since, diagnose, baselines),
  );
}

async function evaluatePredicateRaw(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
  // Compute the (extra-round-trip) near-miss diagnostics on element failures. Default true so a
  // one-shot assert is fully diagnostic; the wait loop passes false on its interim polls (which read
  // only `pass`) and true on the final timeout eval, so a flood no longer pays for a diagnostic nobody
  // reads. Only element/text failures have a near-miss; everything else ignores this.
  diagnose = true,
  baselines?: Baselines,
): Promise<EvalResult> {
  // A predicate's own `since` is a TIGHTER event-time floor than the caller's — an agent that took
  // `since` from the act it just performed is scoping the assertion to that action's aftermath. It is
  // applied here, once, rather than in each eval: the floor means the same thing for every kind that
  // reads the event stream, and net/console re-applying it is a no-op.
  const raw = session.eventsSince(Math.max(since, predicateSince(predicate)));
  // Scoped ONCE, here, for the same reason the contradiction pass scopes at its own choke point:
  // reasoning about a dead page's evidence is a defect in every oracle below rather than in whichever
  // one happened to read it, and this is the single place they all take their window from.
  const events = raw.filter((e) => isSameDocument(e.documentId, session.currentDocumentId));
  const superseded = raw.length - events.length;
  // An empty window was always allowed to mean "it did not happen"; that reading is only unsafe once
  // supersession is what emptied it. Without this, dropping stale evidence would trade a wrong pass
  // for a wrong FAILURE — and a failure names a component and sends an agent to fix working code.
  // `inconclusive` is the established way to say "nothing was proven and nobody could have proven
  // it", and `decideVerified` already reads it as UNKNOWN ahead of the failure clause.
  if (superseded > 0 && 0 === events.length && WINDOW_ONLY_KINDS.has(predicate.kind)) {
    const reason = describeSuperseded('observations', superseded);
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      observed: 'every observation in this window belongs to a document since replaced',
      expected: `evidence recorded under the document now on screen for ${predicate.kind}`,
      assertion: SUPERSEDED_ASSERTION,
    };
  }
  switch (predicate.kind) {
    case PredicateKind.ELEMENT:
      return evalElement(
        session,
        predicate.query,
        predicate.state,
        predicate.absent ?? false,
        diagnose,
      );
    case PredicateKind.TEXT: {
      // `scope` passes straight through: the text predicate has always been an element query with
      // only `text` filled in, so scoping it needs the field, not a second code path. `contains` is
      // optional now that `satisfies` can carry the claim, and an undefined one must not reach the
      // query as `text: undefined` — that is a locator asking for the empty string.
      const query: ElementQuery = {
        ...(undefined === predicate.contains ? {} : { text: predicate.contains }),
        ...(undefined === predicate.scope
          ? {}
          : { scope: predicate.scope, ...(true === predicate.self ? { self: true } : {}) }),
      };
      const found = await evalElement(
        session,
        query,
        true === predicate.visible ? ElementState.VISIBLE : undefined,
        predicate.absent ?? false,
        diagnose,
      );
      if (undefined === predicate.satisfies) return found;
      return withTextProperty(
        found,
        predicate.satisfies,
        JSON.stringify(query),
        baselines?.get(predicate),
      );
    }
    case PredicateKind.NET:
      return evalNet(events, predicate);
    case PredicateKind.ROUTE:
      // `since` so an unanswered request already in flight before this window is not counted
      // against the app — see unansweredIn.
      return evalRoute(events, predicate, session.url, Math.max(since, predicateSince(predicate)));
    case PredicateKind.CONSOLE:
      return evalConsole(events, predicate);
    case PredicateKind.ANIMATION:
      return evalAnimation(events, predicate);
    case PredicateKind.SIGNAL:
      return evalSignal(events, predicate);
    case PredicateKind.STATE:
      return evalState(session, predicate, baselines?.get(predicate));
    case PredicateKind.SETTLED: {
      // Drop events on learned-ambient regions (chat/ticker churn) before the settle check — by ref
      // alone, NOT by attribution: window-attribution ("happened during the action window") is a time
      // heuristic, never causation, so a chat message arriving mid-window must not hold settle open.
      const counts = session.ambientCounts?.();
      const settleEvents =
        counts === undefined ? events : events.filter((e) => !isAmbient(counts, ambientKeyOf(e)));
      return evalSettled(settleEvents, predicate, session.elapsed());
    }
    case PredicateKind.ALL_OF: {
      const results = clearStarvedWhenSiblingsSaw(
        predicate.predicates,
        await Promise.all(
          predicate.predicates.map((p) =>
            evaluatePredicate(session, p, since, diagnose, baselines),
          ),
        ),
      );
      // A clause that genuinely failed OUTRANKS one nobody could read. Softening a real failure to
      // UNKNOWN would hide the defect the agent came for, which is the more expensive of the two
      // mistakes; the reverse — grading an unreadable clause as a defect in the app — is the one
      // that was happening.
      const failed = results.find((r) => !r.pass && r.inconclusive === undefined);
      if (failed !== undefined) {
        return {
          pass: false,
          failureReason: failed.failureReason ?? 'a sub-predicate of allOf failed',
          // A conjunction is decided as soon as ONE clause is: nothing the others do later can
          // rescue it. This is what makes the early exit reach real calls, since an exact count is
          // usually asserted alongside the UI change it is meant to accompany.
          ...(true === failed.decided ? { decided: true } : {}),
          evidence: results,
        };
      }
      const unreadable = results.find((r) => r.inconclusive !== undefined);
      if (unreadable !== undefined) return unreadableComposite(unreadable, results);
      return { pass: true, evidence: results.map((r) => r.evidence) };
    }
    case PredicateKind.ANY_OF: {
      const results = clearStarvedWhenSiblingsSaw(
        predicate.predicates,
        await Promise.all(
          predicate.predicates.map((p) =>
            evaluatePredicate(session, p, since, diagnose, baselines),
          ),
        ),
      );
      const passed = results.find((r) => r.pass);
      if (passed !== undefined) return { pass: true, evidence: passed.evidence };
      // "No sub-predicate matched" is a claim anyOf is not entitled to make while one of them was
      // never read: the unreadable clause might have been the one that would have matched.
      const unreadable = results.find((r) => r.inconclusive !== undefined);
      if (unreadable !== undefined) return unreadableComposite(unreadable, results);
      return { pass: false, failureReason: 'no sub-predicate of anyOf matched', evidence: results };
    }
    case PredicateKind.NOT: {
      const inner = await evaluatePredicate(
        session,
        predicate.predicate,
        since,
        diagnose,
        baselines,
      );
      // The sharpest case of the three, and the only one that produced a GREEN. `not` read the
      // child's `pass: false` as "the inner predicate did not hold" and passed — so an assertion
      // nobody could evaluate became a verdict of verified, manufactured out of a missing reading.
      // You cannot negate an answer nobody had.
      if (inner.inconclusive !== undefined) return unreadableComposite(inner, inner);
      // A green negation used to return a bare `{ pass: true }`, so the payload fell back to
      // whatever the caller had — every element matching the OUTER locator. Three clauses negating
      // three different names then produced byte-identical responses, which reads as a checker that
      // dropped the name rather than one that correctly found all three absent. The evidence is the
      // whole answer here: what was looked for, and that it was not there.
      return inner.pass
        ? { pass: false, failureReason: 'negated predicate unexpectedly held', evidence: inner }
        : { pass: true, evidence: { negated: predicate.predicate, held: false, saw: inner } };
    }
    default:
      return { pass: false, failureReason: 'unknown predicate' };
  }
}

/** Backstop poll cadence — guarantees a re-check even if no event fires (e.g. a `settled` wait). */
const POLL_INTERVAL_MS = 150;
/** Minimum gap between consecutive event-driven rechecks, so an event flood can't drive back-to-back
 *  DOM/STATE round-trips. Small enough that added pass-detection latency is negligible next to the
 *  poll cadence, large enough to collapse a per-frame event storm into a bounded recheck rate. */
const MIN_RECHECK_GAP_MS = 25;

/**
 * How long an exact-count predicate keeps watching AFTER it first reads true.
 *
 * A count only rises while a window is open, so "exactly N" is a statement about the END of one and
 * cannot be settled early — yet every wait here resolves the moment a check passes. Live, on a real
 * payments dashboard: a Refund confirm fired TWO POSTs 59 ms apart, and
 * `until: { kind:'net', method:'POST', urlContains:'/refund', count:1 }` returned
 * `pass: true, matched: 1`. Not a counting bug — `evalNet` counts occurrences correctly. The wait had
 * already stopped looking. So `count: 1` silently meant "at least 1", which is the assertion the
 * caller wrote `count` specifically to avoid, and the branch implementing it claims to catch "the
 * double-submit / useEffect-double-fire / retry-storm regression class".
 *
 * 300 ms is chosen against the measured defect: the observed double-submit gap was 59 ms, a React
 * double-effect fires within one commit, and a retry storm is faster still. It is a real ceiling, not
 * a proof — a duplicate arriving 400 ms later still passes. Widening it costs every exact-count
 * assertion that latency, so this trades an unbounded false green for a bounded one and says so.
 */
const COUNT_CONFIRM_MS = 300;

/**
 * Does this predicate assert an exact cardinality anywhere inside it?
 *
 * Only these hold after passing. A presence-only predicate ("at least one") IS satisfiable early and
 * must stay that way, or every ordinary wait pays the confirmation delay for nothing.
 */
function assertsExactCount(predicate: Predicate): boolean {
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return predicate.predicates.some(assertsExactCount);
  }
  if (PredicateKind.NOT === predicate.kind) return assertsExactCount(predicate.predicate);
  // `signal` carries `count` for the same reason `net` does, and for the same defect: its schema
  // calls the double-fire "the defect no state-only oracle can see", because a handler wired twice
  // leaves the store in the right shape and a presence check green on both. Reading `net` alone
  // meant a signal count resolved on its first match, so `count: 1` silently meant "at least 1" on
  // the one channel able to see the bug. `evalSignal` counts correctly; the wait stopped early.
  return (
    (PredicateKind.NET === predicate.kind || PredicateKind.SIGNAL === predicate.kind) &&
    predicate.count !== undefined
  );
}

/**
 * Evaluate now, else wait for it to become true (on each event + a poll) until timeout. `since` is
 * the event-time floor (see evaluatePredicate) so a waiter cannot resolve on a stale buffered event.
 */
export function waitForPredicate(
  session: PredicateSession,
  predicate: Predicate,
  timeoutMs: number,
  since = 0,
  /** Pre-action readings, for the relative properties. See `evaluatePredicate`. */
  baselines?: Baselines,
): Promise<EvalResult> {
  // Every read in this wait shares the caller's budget; see withinBudget.
  const deadline = session.elapsed() + timeoutMs;
  const reader = withinBudget(session, () => deadline - session.elapsed());
  return new Promise<EvalResult>((resolve) => {
    let done = false;
    // A read that threw never looked at the app: the page did not answer, or went away. That is
    // "could not tell", not "looked and it was false", so it is inconclusive, which the verdict rule
    // turns into unknown. As a plain false it was graded assertion_failed: a command timeout on a
    // live, throttled tab came back verified:no against a page that was never read.
    const failed = (error: unknown): EvalResult => {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        pass: false,
        failureReason: reason,
        inconclusive: `the page did not answer: ${reason}`,
      };
    };
    let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
    /** One-shot re-check timed to when a time-based predicate could first pass. See retryAfterMs. */
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    // An exact-count wait keeps watching after it first reads true — see COUNT_CONFIRM_MS.
    const holdsForCount = assertsExactCount(predicate);
    let confirming = false;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    /** Report a wait that could not run, and END it — see guardedCheck. */
    const failWait = (error: unknown): void => {
      session.note?.('reticle_wait_failed', {
        predicate: predicate.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      finish({
        ...failed(error),
        failureReason:
          'the wait could not be evaluated and was ended rather than left pending: ' +
          (error instanceof Error ? error.message : String(error)),
      });
    };
    const finish = (result: EvalResult): void => {
      if (done) return;
      done = true;
      unsub();
      unsubDisconnect?.();
      clearInterval(interval);
      clearTimeout(timer);
      if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
      if (hintTimer !== undefined) clearTimeout(hintTimer);
      if (confirmTimer !== undefined) clearTimeout(confirmTimer);
      resolve(result);
    };
    // Coalesce re-checks: at most ONE evaluatePredicate is ever in flight (each can be a browser
    // MATCH/STATE_READ round-trip). Events that arrive while one is running set a single trailing
    // re-check instead of each firing their own command — otherwise a page emitting an event per
    // animation frame fans out hundreds of concurrent round-trips and collapses under backpressure.
    //
    // Beyond coalescing, PACE the trailing rechecks: without a gap the next eval fired the instant the
    // previous finished, so under an event flood one round-trip was permanently in flight (~184/sec at
    // 5ms RTT) — each a live-DOM scan on the app's main thread, the "the dashboard is janky while the
    // agent waits" case. The FIRST check on an idle loop still runs immediately (leading edge, so fast
    // detection is unchanged); only back-to-back rechecks under sustained load wait MIN_RECHECK_GAP_MS.
    let inFlight = false;
    let cooling = false;
    let pendingRecheck = false;
    const check = (): void => {
      if (done) return;
      if (inFlight || cooling) {
        pendingRecheck = true;
        return;
      }
      inFlight = true;
      // Interim poll: read only `pass`, so skip the extra near-miss round-trips (diagnose=false). The
      // final timeout eval below runs with full diagnostics.
      void evaluatePredicate(reader, predicate, since, false, baselines)
        .then((r) => {
          if (!r.pass) {
            // Final already: stop rather than spend a budget that cannot change the answer. Only
            // where the evaluator could PROVE it (see EvalResult.decided) — an ordinary miss keeps
            // waiting, because "it has not happened yet" and "it will not happen" are the same
            // reading until the budget ends.
            if (true === r.decided) {
              finish(r);
              return;
            }
            // A time-based failure knows when it could stop being one — re-check THEN rather than on
            // the next blind tick. Without this, every `settled` wait paid up to a full poll interval
            // of dead time after the quiet window had already closed: measured at 566–627ms across
            // the fleet for a 500ms window, on the call an agent makes after almost every action.
            // Additive — the backstop interval below still runs, so a missed hint costs nothing.
            const hint = r.retryAfterMs;
            if ('number' === typeof hint && hint > 0 && hint < POLL_INTERVAL_MS) {
              clearTimeout(hintTimer);
              hintTimer = setTimeout(check, hint);
            }
            return;
          }
          // "Exactly N" cannot be concluded from a passing sample — the count can still rise. Hold,
          // re-evaluate WITH diagnostics, and let that second read be the verdict: if an N+1th
          // arrived in the meantime it now fails, carrying observed/expected rather than a bare no.
          if (!holdsForCount) {
            finish(r);
            return;
          }
          if (confirming) return;
          confirming = true;
          confirmTimer = setTimeout(() => {
            void evaluatePredicate(reader, predicate, since, true, baselines)
              .then(finish)
              .catch((error: unknown) => {
                finish(failed(error));
              });
          }, COUNT_CONFIRM_MS);
        })
        .catch((error: unknown) => {
          finish(failed(error));
        })
        .finally(() => {
          inFlight = false;
          if (done) return;
          // Enter a short cooldown; process a coalesced recheck when it ends. The 150ms poll is the
          // backstop, so a missed trailing edge is caught within one interval regardless.
          cooling = true;
          cooldownTimer = setTimeout(() => {
            cooling = false;
            if (pendingRecheck && !done) {
              pendingRecheck = false;
              check();
            }
          }, MIN_RECHECK_GAP_MS);
        });
    };
    /**
     * Run a re-check so that NOTHING can leave this promise pending.
     *
     * `check` is fired from an event listener and an interval, neither of which is inside the
     * awaited chain. A synchronous throw there reached the process as an uncaughtException; a
     * rejection reached it as an unhandledRejection. Either way the wait never resolved and the tool
     * handler never returned — the agent sees a call that simply never comes back.
     *
     * This half covers the SYNCHRONOUS throw only. The rejection half is handled inside `check`, by
     * the `.catch` on its own promise chain — `check` returns void and voids the promise it starts,
     * so there is nothing to hand back here to await. Said explicitly because the obvious-looking
     * `if (result instanceof Promise) result.catch(…)` that used to sit here was dead code that read
     * like the rejection guard, and removing `check`'s own `.catch` as redundant would have restored
     * the exact hang this exists to prevent.
     *
     * That is the exact shape reported from a Plane (Next 14 + MobX) session, which tears the page
     * session down and rebuilds it on EVERY navigation, so a `{kind:"route"}` predicate always races
     * a teardown of the very session it is watching: `browser.command ok:true` for the click, and
     * then no `tool.handler` for that callId, ever.
     *
     * A wait that cannot evaluate is a FAILED wait, not an eternal one. It now says so and finishes.
     */
    const guardedCheck = (): void => {
      try {
        check();
      } catch (error) {
        failWait(error);
      }
    };
    // Bound to the CALL that started this wait. The listener fires from the WebSocket message
    // handler and the interval from the timer queue — neither is in the awaited chain, so without
    // this every re-check opened a new call at depth 0 and emitted a `browser.command` with no
    // `tool.handler`. Measured on one healthy run: 23 such orphans, which is precisely the
    // documented signature of a HUNG call. A diagnostic that fires on healthy runs is not one.
    const boundCheck = session.keepCallerContext?.(guardedCheck) ?? guardedCheck;
    const unsub = session.onEvent(() => {
      boundCheck();
    });
    const unsubDisconnect = session.onDisconnect?.(() => {
      // `observationLost` is what stops this being graded as an app defect. `pass: false` is still
      // correct — the consequence was not seen to hold — but on its own it reached the verdict rule
      // as ASSERTION_FAILED, so a reload mid-wait reported "the declared consequence did not hold"
      // against a healthy component, by file and line. The flag is structured rather than inferred
      // from this string, because every other `failureReason` here is prose about the APP.
      finish({ pass: false, failureReason: 'session disconnected', observationLost: true });
    });
    const interval = setInterval(boundCheck, POLL_INTERVAL_MS);
    const timer = setTimeout(() => {
      void evaluatePredicate(reader, predicate, since, true, baselines)
        .then((r) => {
          // Spread the near-miss, do NOT hand-copy two fields. The oracle computes observed / expected
          // / assertion — the structured cause the repair literature ranks above prose — and the old
          // `{ pass, evidence, failureReason }` construction DISCARDED them on every timed-out wait and
          // assert. So the highest-value localization signal was computed and then thrown away exactly
          // on the failure path where it matters, no matter what the schema declared.
          finish(
            annotateThrottledMiss(session, predicate, {
              ...r,
              pass: false,
              failureReason: r.failureReason ?? 'timed out waiting for predicate',
            }),
          );
        })
        .catch((error: unknown) => {
          finish(failed(error));
        });
    }, timeoutMs);
    check();
  });
}

/**
 * The ExpectedLinks a GREEN verdict actually PROVED — not merely the ones it declared. Identical to
 * predicateToExpectedLinks except for `anyOf`: an OR greens on a SINGLE branch, so only the branch that
 * held may contribute its link. Grading a green anyOf off the declared links would let the honesty grade
 * claim a signal/net consequence that was only one of the options and never fired — and a `minGrade:net`
 * gate would then trust a verdict that proved nothing but presence. That is the exact false green the
 * grade exists to prevent, sitting inside the grade itself.
 *
 * Call ONLY on a green verdict: a leaf and every `allOf` branch are returned unconditionally because a
 * green top verdict guarantees they held (allOf needs all; a bare leaf IS the verdict). Only anyOf, where
 * green ⇏ this-branch-held, re-checks each branch and keeps the winners.
 */
export async function provenExpectedLinks(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
): Promise<ExpectedLink[]> {
  if (PredicateKind.ALL_OF === predicate.kind) {
    const per = await Promise.all(
      predicate.predicates.map((p) => provenExpectedLinks(session, p, since)),
    );
    return per.flat();
  }
  if (PredicateKind.ANY_OF === predicate.kind) {
    const per = await Promise.all(
      predicate.predicates.map(async (p) =>
        (await evaluatePredicate(session, p, since)).pass
          ? provenExpectedLinks(session, p, since)
          : [],
      ),
    );
    return per.flat();
  }
  return predicateToExpectedLinks(predicate);
}

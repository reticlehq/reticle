import {
  InstrumentationGapKind,
  dedupeGaps,
  instrumentationGap,
  type InstrumentationGap,
} from '@reticlehq/core';

/**
 * The gaps ONE action revealed, derived from facts the act path already holds.
 *
 * Pure, and deliberately fed by primitives rather than by the action result: every fact below is
 * already computed for other reasons — `actedSource` for the red-verdict file:line, `stateUnwatched`
 * because an empty `stateDiffs` would otherwise read as "the app changed nothing", the signal count
 * and route movement for the causal summary. Nothing here costs a new observation. The gap surface
 * is a second reading of evidence Reticle was already collecting and then discarding.
 *
 * ## Each kind carries its OWN gate
 *
 * The rule is that a gap fires only when the verdict came back weaker because of it — and "weaker"
 * is different per kind, so a single global flag would be a lie in both directions:
 *
 *  - a missing source mapping costs nothing on a PASS. The act path already says so in as many
 *    words: on green nobody needs the file:line and it is noise. It costs a great deal on a red,
 *    where it is the first thing the agent wants;
 *  - a missing store costs nothing unless the caller ASKED about state;
 *  - a silent mutation costs nothing if the app proved the outcome some other way.
 *
 * Encoding the gates per kind is what keeps this from degenerating into a linter that fires on every
 * uninstrumented control on the page. That surface would be ignored within a day, and it would take
 * the true positives with it.
 */

export interface ActionInstrumentationFacts {
  /** Did the verdict pass? Several gates turn on this, in different directions. */
  pass: boolean;
  /** True when the outcome was positively PROVED rather than inferred. */
  proved?: boolean;
  /**
   * Does Reticle know a `file:line` for what this verdict is about?
   *
   * A boolean rather than the source itself, deliberately: the act path holds a `{file, line}` and
   * the assert path holds a formatted string it remembered from the last act. The gap does not care
   * which — only whether the agent can be pointed at code — and taking the shape would make one of
   * the two callers convert for no reason.
   */
  sourceKnown: boolean;
  /** The ref that was driven, for the report. */
  ref?: string | undefined;
  /** Did the caller's predicate ask about registered state? */
  stateAsked: boolean;
  /** True when the session has no store registered to read. */
  stateUnwatched: boolean;
  /** Did the DOM move in this action's window? */
  domMutated: boolean;
  /** How many app signals fired in the window. */
  signalsFired: number;
  /** Did the route change in this action's window? */
  routeChanged: boolean;
  /** Did anything signal that route change? */
  routeSignalFired: boolean;
}

export function gapsForAction(facts: ActionInstrumentationFacts): InstrumentationGap[] {
  const gaps: InstrumentationGap[] = [];

  // A red verdict names the control and cannot name the line that renders it. That is the round trip
  // the agent is about to spend, and the one a build plugin removes permanently.
  if (!facts.pass && !facts.sourceKnown) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_SOURCE_MAPPING,
        'the control that was driven carries no source mapping',
        'this verdict can name the control but not the file and line that render it, so finding the code is a separate search',
        { ...(facts.ref === undefined ? {} : { ref: facts.ref }) },
      ),
    );
  }

  // Asked about state, and there is no state channel to answer from.
  if (facts.stateAsked && facts.stateUnwatched) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_STORE_REGISTERED,
        'no store is registered, and this assertion was about state',
        'the assertion could not be answered from the deterministic channel and had to fall back to what the DOM happens to show',
      ),
    );
  }

  // The app moved and said nothing, and Reticle could not prove the outcome another way.
  if (facts.domMutated && 0 === facts.signalsFired && true !== facts.proved) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
        'the DOM changed and no signal fired for it',
        'the outcome had to be inferred from the DOM instead of read from the app asserting its own success, which is the strongest evidence available',
        { ...(facts.ref === undefined ? {} : { ref: facts.ref }) },
      ),
    );
  }

  if (facts.routeChanged && !facts.routeSignalFired) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_ROUTE_SIGNAL,
        'the route changed and nothing signalled it',
        'route consequences cannot be asserted on this app, so a navigation can only be checked by what rendered afterwards',
      ),
    );
  }

  return dedupeGaps(gaps);
}

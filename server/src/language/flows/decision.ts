import {
  AnchorKind,
  DriftReason,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
  type FlowStepResult,
  type ReplayDecision,
  type SuiteFlowResult,
  type FlowStep,
  type SuiteVerdict,
  type SuiteContradiction,
  unreachedRoutes,
  SuiteIsolation,
} from '@reticlehq/core';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';
import { SUCCESS_STEP_TOOL } from './flow-success.js';

/**
 * Turn a replay result into the autonomy DECISION envelope — the judgement a human reviewer used to
 * make, expressed so a coding agent can act on it without one. Pure: no IO, no clock.
 *
 * pass → intent held; next action is none (or "add a consequence oracle" if the flow asserts nothing).
 * drift → a locator/anchor missed; point at WHERE (file:line from the source anchor) + a rebind hint.
 * fail → an action ran but its consequence/success oracle didn't fire (green-but-wrong) — check the handler.
 */

/** The first step that drifted or failed (drift takes precedence as the legible cause). */
function failingStep(steps: FlowStepResult[]): FlowStepResult | undefined {
  return steps.find((s) => s.drift !== undefined) ?? steps.find((s) => !s.ok);
}

/**
 * `file:line` for a step, from whichever anchor recorded provenance — or nothing.
 *
 * It used to fall back to `step.page`, which meant a field named "whereInSource" could return
 * "/checkout". The report writer renders it as **Where:** `<value>`, so a route arrived looking
 * exactly like a file path. A locator that is sometimes a route cannot be trusted when it genuinely
 * is a path, which costs more than the fallback ever added — the page is already reported separately
 * on the step.
 */
function whereInSource(step: FlowStepResult, flow: FlowFile | undefined): string | undefined {
  const anchor = flow?.steps[step.step]?.anchor;
  const source =
    anchor?.kind === AnchorKind.COMPONENT || anchor?.kind === AnchorKind.TESTID
      ? anchor.source
      : undefined;
  return source === undefined ? undefined : `${source.file}:${String(source.line)}`;
}

/**
 * The business outcome that stopped being true, said before the mechanism that broke it.
 *
 * Order is the point. The intent is what makes a failure legible — a human or an agent reading
 * "step 3 assertion failed" has to reconstruct the stakes — and the mechanical detail underneath is
 * what makes it actionable. Dropping either one costs something, so the summary carries both.
 */
const INTENT_BROKEN_PREFIX = 'NO LONGER TRUE: ';
/**
 * What a report says when nothing declared what the flow is for.
 *
 * Never an intent derived from step names: a guessed goal reads as the product owner's words and an
 * agent will act on it. The same rule as the source pointer — absence stays honest.
 */
const NO_INTENT_ON_PASS =
  'no intent declared, so this proves the steps ran, not what they were for — declare one with reticle_intent.';
const NO_INTENT_ON_FAIL = 'no intent declared, so this names the mechanism, not the stakes.';

/** `<intent> — <mechanical>`, or the mechanical sentence plus the honest absence. */
function withIntent(mechanical: string, statement: string | undefined): string {
  return statement === undefined
    ? `${mechanical} — ${NO_INTENT_ON_FAIL}`
    : `${INTENT_BROKEN_PREFIX}"${statement}" — ${mechanical}`;
}

/**
 * @param intentStatement the ledger's current wording, when the flow is bound to an intent row.
 * Falls back to the copy on the flow file, which is what a flow saved before the link carries.
 */
export function buildDecision(
  result: FlowReplayResult,
  flow?: FlowFile,
  intentStatement?: string,
  /** The flows this one invokes, already loaded — see `unverifiableReason`. */
  invoked: ReadonlyMap<string, FlowFile> = new Map(),
): ReplayDecision {
  const { name, status, steps } = result;
  const intentSaid = intentStatement ?? flow?.intent;

  if (status === ReplayStatus.OK) {
    // Green — but is it green-for-the-right-reason? A flow that asserts no consequence can pass while
    // broken, so the honest next action is to add one.
    const grade = flow !== undefined ? classifyFlowAssertions(flow, invoked) : undefined;
    const verifiesOutcome = true === grade?.hasConsequenceAssertion;
    return {
      verdict: 'pass',
      summary:
        intentSaid !== undefined
          ? `"${name}" passed — intent "${intentSaid}" ${verifiesOutcome ? 'verified' : 'NOT asserted'}.`
          : `"${name}" passed (${steps.length} steps) — ${NO_INTENT_ON_PASS}`,
      nextAction: verifiesOutcome
        ? 'none — the flow held and its consequence was observed.'
        : 'add a consequence assertion (assert-signal / success-state) so this flow can fail when the feature breaks.',
    };
  }

  const step = failingStep(steps);
  const where = step !== undefined ? whereInSource(step, flow) : undefined;

  if (status === ReplayStatus.DRIFT && step?.drift !== undefined) {
    const { drift } = step;
    /*
     * The step's anchor resolved and its action ran; what never appeared is the thing the step
     * ASSERTED afterwards. Everything below this line is written for the other case, and applying
     * it here produced three wrong answers from one cause — MEASURED on the bench app, where a
     * click on `login-submit` expecting `nav-deployments` reported the file of the button, advised
     * rebinding an anchor that had resolved, and named `login-submit` as the replacement for it,
     * i.e. rebinding the anchor to the value it already had.
     *
     * `DriftReason.EXPECT_ELEMENT_NOT_FOUND` exists precisely to separate the two; only this
     * function had not read it.
     */
    if (DriftReason.EXPECT_ELEMENT_NOT_FOUND === drift.reasonKind) {
      /*
       * `nearest` is the closest testid PRESENT when the assertion was evaluated, which for this
       * kind of drift is a page the journey may never have reached — after a sign-in that did not
       * happen, the survivors are the login form. It is worth proposing only when it is not the
       * step's own anchor, and even then it is a rename of the EXPECTATION, never of the anchor.
       */
      const renamed =
        drift.nearest !== null && drift.ambiguous !== true && drift.nearest !== step.anchor
          ? `the consequence may have been renamed: update this step's expect to "${drift.nearest}"`
          : undefined;
      return {
        verdict: 'drift',
        summary: withIntent(
          `"${name}" ran step ${step.step} (${step.anchor}) and its consequence never appeared.`,
          intentSaid,
        ),
        whatChanged: drift.reason,
        // No `whereInSource`. The anchor's source is the element that was ACTED ON, and this step's
        // anchor is not what failed; nothing recorded a source for the expected element. A locator
        // pointing at the wrong file costs more than no locator, which is the same reasoning that
        // removed the `step.page` fallback above.
        ...(renamed !== undefined ? { suggestedFix: renamed } : {}),
        nextAction:
          renamed !== undefined
            ? `${renamed}, or check the handler behind the action if the consequence should still fire.`
            : 'the action ran and the expected consequence never appeared — check the handler behind it, or whether this flow needs a state it did not start in. The locator is not the problem.',
      };
    }
    const fix =
      drift.nearest !== null && drift.ambiguous !== true
        ? `rebind the anchor to "${drift.nearest}" (closest survivor)`
        : drift.nearest !== null
          ? `candidates exist (e.g. "${drift.nearest}") but are ambiguous — choose deliberately`
          : undefined;
    return {
      verdict: 'drift',
      summary: withIntent(`"${name}" drifted at step ${step.step} (${step.anchor}).`, intentSaid),
      whatChanged: drift.reason,
      ...(where !== undefined ? { whereInSource: where } : {}),
      ...(fix !== undefined ? { suggestedFix: fix } : {}),
      nextAction:
        fix !== undefined
          ? `${fix}, or update the flow if the change was intended.`
          : `inspect ${where ?? 'the step'} — the anchored element is gone; rebind or update the flow.`,
    };
  }

  // status error: an action failed, or the success oracle was not satisfied (green-but-wrong).
  const message = result.error?.message ?? step?.error ?? 'the flow failed';
  const isSuccessOracle = step?.tool === SUCCESS_STEP_TOOL;
  return {
    verdict: 'fail',
    summary: withIntent(
      `"${name}" failed${step !== undefined ? ` at step ${step.step} (${step.anchor})` : ''}.`,
      intentSaid,
    ),
    whatChanged: message,
    ...(where !== undefined ? { whereInSource: where } : {}),
    nextAction: isSuccessOracle
      ? 'the steps ran but the business outcome never fired — check the handler/effect behind the action, not the locator.'
      : 'the action could not complete — check the element state and the handler at the step above.',
  };
}

/** Map a replay status to the suite verdict's three-state outcome. */
function suiteVerdictOf(status: ReplayStatus): 'pass' | 'drift' | 'fail' {
  if (status === ReplayStatus.OK) return 'pass';
  return status === ReplayStatus.DRIFT ? 'drift' : 'fail';
}

/**
 * Aggregate per-flow replays into one suite verdict — the autonomous loop's consolidated answer
 * after a build: did anything break, and what's the prioritized fix list. Pure: pass the already
 * decision-annotated replay results + their flows. Passing flows are counted; only failures carry
 * detail (token-cheap), each with the actionable decision so the agent fixes without re-querying.
 */
/**
 * Why a green replay still verified nothing, or undefined when it genuinely did.
 *
 * A flow with no steps, or one that asserts no observable consequence, replays green no matter what
 * the app does — the grader already knows this at save time and says so. Counting it as `passed`
 * turned that warning into "all 1 flow pass", which is a false green in the exact feature sold as
 * the regression suite. Classified only when the flow file is available; never guessed.
 */
export function unverifiableReason(
  flow: FlowFile | undefined,
  /**
   * The flows this one invokes, already loaded.
   *
   * A composite asserts through what it RUNS. Without these it is graded on the one step it
   * contains and reported `unverifiable` however thoroughly its sub-journeys check themselves —
   * which is a warning that is right about the file and wrong about the journey, and the only ways
   * to silence it are to duplicate assertions into every caller or to stop reading warnings.
   */
  invoked: ReadonlyMap<string, FlowFile> = new Map(),
): string | undefined {
  if (flow === undefined) return undefined;
  if (0 === flow.steps.length) {
    return 'the flow has no steps — it replays green whatever the app does. Record it again, or add steps with reticle_annotate.';
  }
  const c = classifyFlowAssertions(flow, invoked);
  if (c.grade !== FlowAssertionGrade.ASSERTION_FREE) return undefined;
  return (
    c.warning ??
    'the flow asserts no observable consequence, so it passes even when the feature is broken.'
  );
}

/**
 * @param knownRoutes every route the project has been seen to have — each flow's `startPath`,
 * including the flows this run held back. Omit it when nothing is known; see `unreached`.
 */
export function buildSuiteVerdict(
  runs: ReadonlyArray<{ replay: FlowReplayResult; flow?: FlowFile }>,
  knownRoutes: readonly string[] = [],
  /**
   * How the flows were kept apart. Omitted by callers that have not been taught to say, and then
   * nothing is claimed — an invented isolation would be worse than a missing one.
   */
  isolation?: SuiteIsolation,
): SuiteVerdict {
  const failures: SuiteFlowResult[] = [];
  const unverifiable: { flow: string; reason: string }[] = [];
  let passed = 0;
  for (const { replay, flow } of runs) {
    if (replay.status === ReplayStatus.OK) {
      /*
       * The REPLAY's own answer first, then the grader's.
       *
       * This recomputed from the flow file alone, which can only see the one thing a file can say
       * about itself: whether it asserts anything. It cannot see what happened at run time - and an
       * unmet PRECONDITION is exactly that: the flow is fine, its assertions are fine, and it never
       * ran because the state it needs was not there. Ignoring `replay.unverifiable` counted that as
       * a PASS, which is the worst of the three available answers: a flow that did nothing, reported
       * as a flow that proved something.
       */
      const reason = replay.unverifiable?.reason ?? unverifiableReason(flow);
      // A green that cannot go red is not a pass. Counted apart, so `passed` stays a count of things
      // actually verified rather than of replays that merely completed.
      if (reason !== undefined) unverifiable.push({ flow: replay.name, reason });
      else passed += 1;
      continue;
    }
    const decision = replay.decision ?? buildDecision(replay, flow);
    const row: SuiteFlowResult = { flow: replay.name, verdict: suiteVerdictOf(replay.status) };
    // Zero step results PLUS an error is the signature of a replay that never STARTED — the flow file
    // failed to load (before the session is even resolved), or its leased context never came up. A
    // flow that ran and failed always carries its failing step; a flow with no steps replays OK and
    // never reaches here. Both arrive as ReplayStatus.ERROR, so without this the suite cannot tell
    // "the app broke" from "Reticle could not run this" — and the bug metric reported the second as
    // the first, 8 times in one sweep.
    if (0 === replay.steps.length && replay.error !== undefined) row.couldNotRun = true;
    if (decision.whatChanged !== undefined) row.whatChanged = decision.whatChanged;
    if (decision.whereInSource !== undefined) row.whereInSource = decision.whereInSource;
    row.nextAction = decision.nextAction;
    failures.push(row);
  }
  /*
   * Collected from EVERY run, not only the failures.
   *
   * A failing flow's contradictions would otherwise only reach a reader who went and fetched the
   * replay; a passing flow's would reach nobody at all. Both are the same finding, and the second is
   * the more dangerous one, because nothing else about that run invites a second look.
   */
  const contradictions: SuiteContradiction[] = [];
  for (const { replay } of runs) {
    for (const step of replay.steps) {
      for (const found of step.contradictions ?? []) {
        contradictions.push({ flow: replay.name, step: step.step, ...found });
      }
    }
    /* Step -1: this one belongs to no single step — that is the whole reason it was looked for. */
    for (const found of replay.crossStep ?? []) {
      contradictions.push({ flow: replay.name, step: -1, ...found });
    }
  }
  const disagreed =
    0 === contradictions.length
      ? ''
      : ` — ${String(contradictions.length)} contradiction(s): a channel disagrees with what the app showed, on ${[...new Set(contradictions.map((c) => c.flow))].join(', ')}`;

  const total = runs.length;
  const failed = failures.length;
  // A real failure outranks an unverifiable flow: a broken flow is worse news than an empty one.
  // An EMPTY suite is unverifiable for the same reason a flow that asserts nothing is — it is the
  // purest green that cannot go red. It used to report `pass` with the summary "all 0 flows pass",
  // which meant `reticle verify` went green on every project that had not written a flow yet, and on
  // any project where the flows directory failed to resolve. Found by the adversarial MCP sweep; it
  // was the only invented answer in 994 calls.
  const status: SuiteVerdict['status'] =
    failed > 0
      ? 'fail'
      : /*
         * A green run with a contradiction is not a `pass`. Nothing the flow DECLARED went unproved,
         * so calling it `fail` would say the wrong thing — but a suite whose channels disagree is
         * exactly a green that cannot be trusted, which is what `unverifiable` already means here.
         */
        unverifiable.length > 0 || contradictions.length > 0 || 0 === total
        ? 'unverifiable'
        : 'pass';
  const cannotFail =
    0 === unverifiable.length
      ? ''
      : ` — ${String(unverifiable.length)} verified nothing (${unverifiable.map((u) => u.flow).join(', ')})`;
  const coverage = suiteCoverage(runs);
  /*
   * Said in the summary, not only in a field. A number nobody reads is a number that does not exist,
   * and the whole point of this one is that a green suite can still be mostly unproved.
   */
  const silentSteps =
    coverage === undefined || coverage.declared === coverage.steps
      ? ''
      : ` — only ${String(coverage.declared)} of ${String(coverage.steps)} steps declared a consequence; the rest were driven, not verified`;
  const visited = runs
    .map((run) => run.flow?.startPath)
    .filter((path): path is string => path !== undefined);
  const unreached = unreachedRoutes(knownRoutes, visited);
  /* Same reason as the coverage line: a gap stated only in a field is a gap nobody reads. */
  const neverOpened =
    0 === unreached.length
      ? ''
      : ` — ${String(unreached.length)} known route(s) never opened: ${unreached.join(', ')}`;
  const summary =
    0 === total
      ? 'no flows to verify — nothing was checked. Record one with reticle_record { action: "start" }, then reticle_flow_save.'
      : 0 === failed
        ? 0 === unverifiable.length
          ? `all ${total} flow${1 === total ? '' : 's'} pass`
          : `${String(passed)}/${String(total)} flows verified${cannotFail}`
        : `${passed}/${total} flows pass — ${failed} need attention: ${failures.map((f) => f.flow).join(', ')}${cannotFail}`;
  /*
   * A shared-session pass can be inherited, so the count is not comparable with a leased one.
   *
   * MEASURED: the same 34 flows answered 13 sequentially and 11 under per-flow leases, both
   * reproducible. The four that differ click a nav item behind a sign-in and never sign in — they
   * pass only because an earlier flow in the run signed in, and would pass with sign-in entirely
   * broken. Saying which mode produced the number is what stops the two being read as a regression.
   */
  const sharedState =
    SuiteIsolation.SHARED_SESSION === isolation && total > 1
      ? ' — these flows shared one session and ran in order, so a pass here may rest on state an earlier flow left behind; replay with `parallel` to give each its own context'
      : '';
  return {
    status,
    total,
    passed,
    failed,
    summary: summary + silentSteps + neverOpened + disagreed + sharedState,
    failures,
    ...(isolation === undefined ? {} : { isolation }),
    ...(unverifiable.length > 0 ? { unverifiable } : {}),
    ...(coverage === undefined ? {} : { coverage }),
    ...(0 === unreached.length ? {} : { unreached }),
    ...(0 === contradictions.length ? {} : { contradictions }),
  };
}

/**
 * Steps driven, and steps that declared a consequence.
 *
 * Counted from the FLOW rather than from the results, because "did this step declare something" is a
 * property of what was recorded, not of what happened when it ran — a step that declared and failed
 * still declared.
 *
 * Sub-steps count. `classifyFlowAssertions` already walks act_sequence children for exactly this
 * reason, and a sequence of five clicks is five steps to anybody reading the number.
 *
 * Undefined when no flow file was available: a replay whose file could not be loaded cannot be
 * counted, and an invented zero reads as "nothing was declared" rather than "nothing was counted".
 */
function suiteCoverage(
  runs: ReadonlyArray<{ flow?: FlowFile }>,
): { steps: number; declared: number } | undefined {
  const flows = runs.map((run) => run.flow).filter((flow): flow is FlowFile => flow !== undefined);
  if (0 === flows.length) return undefined;
  let steps = 0;
  let declared = 0;
  const walk = (list: readonly FlowStep[]): void => {
    for (const step of list) {
      if (step.steps !== undefined && step.steps.length > 0) {
        walk(step.steps);
        continue;
      }
      steps += 1;
      if (step.expect !== undefined) declared += 1;
    }
  };
  for (const flow of flows) walk(flow.steps);
  return { steps, declared };
}

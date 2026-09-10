import {
  AnchorKind,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
  type FlowStepResult,
  type ReplayDecision,
  type SuiteFlowResult,
  type SuiteVerdict,
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
): ReplayDecision {
  const { name, status, steps } = result;
  const intentSaid = intentStatement ?? flow?.intent;

  if (status === ReplayStatus.OK) {
    // Green — but is it green-for-the-right-reason? A flow that asserts no consequence can pass while
    // broken, so the honest next action is to add one.
    const grade = flow !== undefined ? classifyFlowAssertions(flow) : undefined;
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
export function unverifiableReason(flow: FlowFile | undefined): string | undefined {
  if (flow === undefined) return undefined;
  if (0 === flow.steps.length) {
    return 'the flow has no steps — it replays green whatever the app does. Record it again, or add steps with reticle_annotate.';
  }
  const c = classifyFlowAssertions(flow);
  if (c.grade !== FlowAssertionGrade.ASSERTION_FREE) return undefined;
  return (
    c.warning ??
    'the flow asserts no observable consequence, so it passes even when the feature is broken.'
  );
}

export function buildSuiteVerdict(
  runs: ReadonlyArray<{ replay: FlowReplayResult; flow?: FlowFile }>,
): SuiteVerdict {
  const failures: SuiteFlowResult[] = [];
  const unverifiable: { flow: string; reason: string }[] = [];
  let passed = 0;
  for (const { replay, flow } of runs) {
    if (replay.status === ReplayStatus.OK) {
      const reason = unverifiableReason(flow);
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
  const total = runs.length;
  const failed = failures.length;
  // A real failure outranks an unverifiable flow: a broken flow is worse news than an empty one.
  // An EMPTY suite is unverifiable for the same reason a flow that asserts nothing is — it is the
  // purest green that cannot go red. It used to report `pass` with the summary "all 0 flows pass",
  // which meant `reticle verify` went green on every project that had not written a flow yet, and on
  // any project where the flows directory failed to resolve. Found by the adversarial MCP sweep; it
  // was the only invented answer in 994 calls.
  const status: SuiteVerdict['status'] =
    failed > 0 ? 'fail' : unverifiable.length > 0 || 0 === total ? 'unverifiable' : 'pass';
  const cannotFail =
    0 === unverifiable.length
      ? ''
      : ` — ${String(unverifiable.length)} verified nothing (${unverifiable.map((u) => u.flow).join(', ')})`;
  const summary =
    0 === total
      ? 'no flows to verify — nothing was checked. Record one with reticle_record { action: "start" }, then reticle_flow_save.'
      : 0 === failed
        ? 0 === unverifiable.length
          ? `all ${total} flow${1 === total ? '' : 's'} pass`
          : `${String(passed)}/${String(total)} flows verified${cannotFail}`
        : `${passed}/${total} flows pass — ${failed} need attention: ${failures.map((f) => f.flow).join(', ')}${cannotFail}`;
  return {
    status,
    total,
    passed,
    failed,
    summary,
    failures,
    ...(unverifiable.length > 0 ? { unverifiable } : {}),
  };
}

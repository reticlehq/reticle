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
import { classifyFlowAssertions } from './flow-classify.js';

/**
 * Turn a replay result into the autonomy DECISION envelope — the judgement a human reviewer used to
 * make, expressed so a coding agent can act on it without one. Pure: no IO, no clock.
 *
 *   pass  → intent held; next action is none (or "add a consequence oracle" if the flow asserts nothing).
 *   drift → a locator/anchor missed; point at WHERE (file:line from the source anchor) + a rebind hint.
 *   fail  → an action ran but its consequence/success oracle didn't fire (green-but-wrong) — check the handler.
 */

/** The first step that drifted or failed (drift takes precedence as the legible cause). */
function failingStep(steps: FlowStepResult[]): FlowStepResult | undefined {
  return steps.find((s) => s.drift !== undefined) ?? steps.find((s) => !s.ok);
}

/** `file:line` for a step, preferring the recorded component anchor's source, else the live page. */
function whereInSource(step: FlowStepResult, flow: FlowFile | undefined): string | undefined {
  const anchor = flow?.steps[step.step]?.anchor;
  if (anchor?.kind === AnchorKind.COMPONENT && anchor.source !== undefined) {
    return `${anchor.source.file}:${anchor.source.line}`;
  }
  return step.page;
}

export function buildDecision(result: FlowReplayResult, flow?: FlowFile): ReplayDecision {
  const { name, status, steps } = result;

  if (status === ReplayStatus.OK) {
    // Green — but is it green-for-the-right-reason? A flow that asserts no consequence can pass while
    // broken, so the honest next action is to add one.
    const grade = flow !== undefined ? classifyFlowAssertions(flow) : undefined;
    const verifiesOutcome = grade?.hasConsequenceAssertion === true;
    const intent = flow?.intent;
    return {
      verdict: 'pass',
      summary:
        intent !== undefined
          ? `"${name}" passed — intent "${intent}" ${verifiesOutcome ? 'verified' : 'NOT asserted'}.`
          : `"${name}" passed (${steps.length} steps).`,
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
      summary: `"${name}" drifted at step ${step.step} (${step.anchor}).`,
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
  const isSuccessOracle = step?.tool === 'success';
  return {
    verdict: 'fail',
    summary: `"${name}" failed${step !== undefined ? ` at step ${step.step} (${step.anchor})` : ''}.`,
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
export function buildSuiteVerdict(
  runs: ReadonlyArray<{ replay: FlowReplayResult; flow?: FlowFile }>,
): SuiteVerdict {
  const failures: SuiteFlowResult[] = [];
  let passed = 0;
  for (const { replay, flow } of runs) {
    if (replay.status === ReplayStatus.OK) {
      passed += 1;
      continue;
    }
    const decision = replay.decision ?? buildDecision(replay, flow);
    const row: SuiteFlowResult = { flow: replay.name, verdict: suiteVerdictOf(replay.status) };
    if (decision.whatChanged !== undefined) row.whatChanged = decision.whatChanged;
    if (decision.whereInSource !== undefined) row.whereInSource = decision.whereInSource;
    row.nextAction = decision.nextAction;
    failures.push(row);
  }
  const total = runs.length;
  const failed = failures.length;
  const status = failed === 0 ? 'pass' : 'fail';
  const summary =
    failed === 0
      ? `all ${total} flow${total === 1 ? '' : 's'} pass`
      : `${passed}/${total} flows pass — ${failed} need attention: ${failures.map((f) => f.flow).join(', ')}`;
  return { status, total, passed, failed, summary, failures };
}

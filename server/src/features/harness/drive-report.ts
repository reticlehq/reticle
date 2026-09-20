/**
 * What a drive did, written from the evidence rather than narrated by the model that drove.
 *
 * `HarnessResult.summary` is the driver's own account, and it has always carried a warning that
 * nothing downstream grades it. That was a caveat when the driver was a language model. It became a
 * hole the moment a System One model could drive: Jev answers typed questions and cannot produce a
 * sentence, so `summary` came back EMPTY, and an agent calling `explore` got a result with no
 * account of what had happened in it at all.
 *
 * Restoring prose would have been the obvious fix and the wrong one. The drive already records
 * every call it made, with the arguments it used and the verdict the engine returned — so the
 * account can be DERIVED. That is strictly better than a narration: a model summarising its own
 * drive is the one witness with a reason to round "unknown" up to "worked", and this cannot, because
 * it is not writing about the drive, it is reading it.
 *
 * Written for the agent on the other end of the MCP call. It leads with what was proved, because
 * that is what a coding agent has to gate on, and it says "not proved" in those words rather than
 * leaving a verdict of `unknown` to be read as a pass.
 */

import { asRecord, asString, ReticleTool, Verified } from '@reticlehq/core';
import type { ToolOutcome } from './harness.js';

/** One driven action, reduced to what a reader needs: what was done, and what it proved. */
export interface DrivenStep {
  /** The action verb, e.g. `click`. */
  action: string;
  /** The element, named the way a person would say it, falling back to the ref. */
  target: string;
  /** The engine's verdict for this step, when the step declared anything. */
  verified: string | undefined;
  /** The one sentence naming the deciding evidence. */
  because: string | undefined;
  /**
   * What the drive CLAIMED would happen, in the words it declared before acting.
   *
   * Carried because "3 action(s) FAILED" is not triageable without it. A failure is either a defect
   * in the app or a wrong guess by the driver, those need opposite responses, and the declared
   * consequence is the only thing that tells them apart. Shown on failures only: on a pass it is
   * noise, and the report is read every drive.
   */
  claimed: string | undefined;
}

/** How many steps are listed before the account starts counting instead of naming. */
const MAX_LISTED = 12;

/** Actions that change the app. Reads are not part of the story of what was driven. */
const DRIVING_TOOLS = new Set<string>([
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.NAVIGATE,
]);

/**
 * The human-readable name of what was acted on.
 *
 * The ref (`e42`) is meaningless to the agent reading this — it is a handle that expired when the
 * page changed. A description that says `button "Create"` survives being read tomorrow, so the ref
 * is only the fallback.
 */
function targetOf(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const described = asString(result['element']) ?? asString(result['name']);
  if (described !== undefined && 0 < described.length) return described;
  const target = asRecord(args['target']);
  for (const key of ['testid', 'text', 'label', 'name']) {
    const value = asString(target[key]);
    if (value !== undefined && 0 < value.length) return `${key}=${value}`;
  }
  const url = asString(args['url']);
  if (url !== undefined && 0 < url.length) return url;
  return asString(args['ref']) ?? 'the page';
}

/**
 * Replays this drive ran, and what each came back with.
 *
 * The verdict is `status`, not `passed`. Reading the wrong key reported ten replays as "undecided"
 * on a run where every one of them had answered — which is the same false-nothing this report was
 * written to stop, made by the report itself.
 *
 * Three outcomes, kept apart because they mean different things to whoever reads this. `ok` is the
 * journey still holding. `error` is it failing. `drift` is the flow's own anchors no longer
 * resolving — the app moved under a recording, which is a finding about the RECORDING rather than
 * proof the feature broke, and collapsing it into "failed" would send somebody to fix working code.
 */
export const ReplayOutcome = { OK: 'ok', DRIFT: 'drift', ERROR: 'error' } as const;

export function replayedFlows(
  toolCalls: readonly ToolOutcome[],
): { name: string; status: string | undefined }[] {
  const out: { name: string; status: string | undefined }[] = [];
  for (const call of toolCalls) {
    if (ReticleTool.FLOW_REPLAY !== call.name) continue;
    const name = asString(asRecord(call.args)['flowName']) ?? 'a flow';
    out.push({
      name,
      status: call.isError ? ReplayOutcome.ERROR : asString(asRecord(call.result)['status']),
    });
  }
  return out;
}

/**
 * The declared consequence, as a short phrase rather than a JSON dump.
 *
 * One line per kind, because a reader triaging a red needs "it claimed a POST" and not the
 * predicate's wire shape. Unknown kinds fall back to the kind name, which is still more than the
 * nothing this used to say.
 */
function describeClaim(until: unknown): string | undefined {
  const p = asRecord(until);
  const kind = asString(p['kind']);
  if (kind === undefined) return undefined;
  if ('signal' === kind) {
    const name = asString(p['name']);
    return name === undefined ? 'a signal' : `signal ${name}`;
  }
  if ('net' === kind) {
    const method = asString(p['method']);
    const url = asString(p['urlContains']);
    return `a ${method ?? ''} request${url === undefined ? '' : ` to ${url}`}`.replace('  ', ' ');
  }
  if ('route' === kind) return `a route containing ${asString(p['contains']) ?? '?'}`;
  if ('not' === kind) {
    const inner = describeClaim(p['predicate']);
    return inner === undefined ? 'not something' : `to leave ${inner}`;
  }
  if ('anyOf' === kind) return 'a request or a signal';
  return kind;
}

/** Reduce the raw call log to the actions that actually drove the app. */
export function drivenSteps(toolCalls: readonly ToolOutcome[]): DrivenStep[] {
  const steps: DrivenStep[] = [];
  for (const call of toolCalls) {
    if (!DRIVING_TOOLS.has(call.name)) continue;
    const args = asRecord(call.args);
    const result = asRecord(call.result);
    const action =
      ReticleTool.NAVIGATE === call.name ? 'navigate' : (asString(args['action']) ?? 'act');
    steps.push({
      action,
      target: targetOf(args, result),
      verified: call.isError ? 'error' : asString(result['verified']),
      because: call.isError ? asString(result['error']) : asString(result['because']),
      claimed: describeClaim(args['until']),
    });
  }
  return steps;
}

/**
 * The account, as lines.
 *
 * Proved and not-proved are counted separately and both are stated, because the failure mode this
 * whole product exists to prevent is a reader taking "we did twelve things" for "twelve things
 * work". `unknown` is deliberately grouped under NOT proved and labelled as undecided evidence
 * rather than as a failure — it calls for a better check, not a code change, and collapsing the two
 * would send an agent to rewrite working code.
 */
export function describeDrive(
  toolCalls: readonly ToolOutcome[],
  savedFlows: readonly string[],
): string {
  const steps = drivenSteps(toolCalls);
  const replays = replayedFlows(toolCalls);

  /*
   * A run that only REPLAYED is not a run that did nothing.
   *
   * "Nothing was driven" was true of the actions and wrong about the run: sixteen recorded journeys
   * replayed deterministically, for zero model tokens, and the report called it empty. That is the
   * cheap half of the plan working exactly as intended, and it has to read as a result.
   */
  const replayLine =
    0 === replays.length
      ? undefined
      : (() => {
          const held = replays.filter((r) => ReplayOutcome.OK === r.status);
          const failed = replays.filter((r) => ReplayOutcome.ERROR === r.status);
          const drifted = replays.filter((r) => ReplayOutcome.DRIFT === r.status);
          const lines = [
            `Replayed ${String(replays.length)} recorded journey(s) with NO model in the loop: ` +
              `${String(held.length)} still hold, ${String(failed.length)} failed, ${String(drifted.length)} drifted.`,
          ];
          if (0 < failed.length)
            lines.push(
              `  FAILED: ${failed.map((r) => r.name).join(', ')} — regressions in journeys that used to pass.`,
            );
          if (0 < drifted.length)
            lines.push(
              `  DRIFTED: ${drifted.map((r) => r.name).join(', ')} — the app moved under these recordings; the flow needs re-anchoring, not the app fixing.`,
            );
          return lines.join('\n');
        })();

  if (0 === steps.length)
    return (
      replayLine ??
      'Nothing was driven and nothing was replayed: the run made no action against the app.'
    );

  const proved = steps.filter((step) => Verified.YES === step.verified);
  const failed = steps.filter((step) => Verified.NO === step.verified);
  const undecided = steps.filter(
    (step) => Verified.YES !== step.verified && Verified.NO !== step.verified,
  );

  const lines: string[] = [
    ...(replayLine === undefined ? [] : [replayLine]),
    `Drove ${String(steps.length)} action(s): ${String(proved.length)} proved, ` +
      `${String(failed.length)} failed, ${String(undecided.length)} not decided.`,
  ];

  for (const step of steps.slice(0, MAX_LISTED)) {
    const verdict = step.verified ?? 'nothing declared';
    const because = step.because === undefined ? '' : ` — ${step.because}`;
    // The claim, on failures only: it is what separates "the app is broken" from "the drive guessed
    // wrong", and those two readings need opposite responses from whoever reads this.
    const claimed =
      Verified.NO === step.verified && step.claimed !== undefined
        ? ` (claimed ${step.claimed})`
        : '';
    lines.push(`  ${step.action} ${step.target}: ${verdict}${claimed}${because}`);
  }
  if (MAX_LISTED < steps.length) lines.push(`  … and ${String(steps.length - MAX_LISTED)} more.`);

  if (0 < failed.length)
    lines.push(
      `${String(failed.length)} action(s) FAILED — the app did not do what the drive declared it would. These are findings.`,
    );
  if (0 < undecided.length)
    lines.push(
      `${String(undecided.length)} action(s) were NOT PROVED. That is undecided evidence, not a failure: it calls for a better check, not a code change.`,
    );
  if (0 < savedFlows.length)
    lines.push(
      `Replay any of this without a model: reticle_verify { action: "flows" } — saved ${savedFlows.join(', ')}.`,
    );

  return lines.join('\n');
}

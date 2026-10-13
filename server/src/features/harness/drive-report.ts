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

import { appFindings } from './app-findings.js';
import { MSG_OPENED_MENU, MSG_ROUTE_GUESS_MISSED, claimsOnlyRoute } from './route-guess.js';
import {
  asRecord,
  asString,
  ActionType,
  NO_SUCH_FLOW,
  ReplayStatus,
  ReticleTool,
  ScriptStatus,
  Verified,
} from '@reticlehq/core';
import type { ToolOutcome } from './harness.js';
import { PredicateSchema } from '@reticlehq/engine/question/predicate/predicate-schema.js';
import { describeWaitTarget } from '@reticlehq/engine/evidence/unsettled.js';

/** One driven action, reduced to what a reader needs: what was done, and what it proved. */
export interface DrivenStep {
  /** The action verb, e.g. `click`. */
  action: string;
  /** The element, named the way a person would say it, falling back to the ref. */
  target: string;
  /** The engine's verdict for this step, when the step declared anything. */
  verified: string | undefined;
  /** A route claim that missed: the driver's own guess, or a menu it opened. Never a check. */
  guess?: true;
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
  /**
   * What the engine saw that decided it: each channel that disagreed, and any write the app sent
   * that failed. The act's own result carries all of it; a report that kept only the verdict word
   * handed the caller "unit-mismatch" and left it unable to say what was wrong.
   */
  evidence: string[];
}

function refusedAsDestructive(call: ToolOutcome): boolean {
  const error = asString(asRecord(call.result)['error']) ?? '';
  return call.isError && error.includes(DESTRUCTIVE_REFUSAL);
}

/** Driving calls that ran with the destructive-action permission: these really changed the app. */
export function confirmedDestructive(toolCalls: readonly ToolOutcome[]): number {
  return toolCalls.filter(
    (call) =>
      DRIVING_TOOLS.has(call.name) &&
      !call.isError &&
      true === asRecord(asRecord(call.args)['args'])[DESTRUCTIVE_REFUSAL],
  ).length;
}

/**
 * A failed claim whose page then showed a dialog: the control opens a confirmation, and the drive
 * guessed it would send the request itself. Reported as a defect, a row's "Refund" button that opens
 * the "Refund now" dialog sent the caller looking for a dead control.
 */
function openedADialog(result: Record<string, unknown>, after: readonly ToolOutcome[]): string[] {
  if (Verified.NO !== result['verified']) return [];
  const next = after.find((call) => ReticleTool.SNAPSHOT === call.name);
  const dialogs = asRecord(asRecord(next?.result)['status'])['visibleDialogs'];
  return Array.isArray(dialogs) && 0 < dialogs.length
    ? [
        'it opened a dialog instead: likely the drive guessed the consequence wrong, not an app defect',
      ]
    : [];
}

/** Characters of a response body quoted in the evidence: enough for an error message. */
const MAX_BODY_CHARS = 200;
/** Contradictions quoted per step. */
const MAX_EVIDENCE = 3;

/** The deciding evidence an act result carries, as short lines. */
function evidenceOf(result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const contradictions = result['contradictions'];
  if (Array.isArray(contradictions)) {
    for (const raw of contradictions.slice(0, MAX_EVIDENCE)) {
      const c = asRecord(raw);
      const parts = [asString(c['counter']), asString(c['detail'])].filter(
        (part): part is string => part !== undefined && 0 < part.length,
      );
      lines.push(`${asString(c['kind']) ?? 'contradiction'}: ${parts.join(' — ')}`);
    }
  }
  const verdict = asRecord(result['verdict']);
  const seen = asRecord(verdict['evidence']);
  const status = seen['status'];
  if ('number' === typeof status && 400 <= status) {
    const body = asString(seen['responseBody']);
    lines.push(
      `${asString(seen['method']) ?? ''} ${asString(seen['url']) ?? ''} → ${String(status)}` +
        (body === undefined ? '' : ` ${body.slice(0, MAX_BODY_CHARS)}`),
    );
  }
  const observed = asString(verdict['observed']);
  if (false === verdict['pass'] && observed !== undefined) lines.push(`observed: ${observed}`);
  return lines;
}

/** The permission a destructive action needs, named in the gate's refusal and carried on a retry. */
const DESTRUCTIVE_REFUSAL = 'confirmDangerous';

/** How many steps are listed before the account starts counting instead of naming. */
const MAX_LISTED = 12;
/**
 * Failures are listed first, and up to this many of them however long the run. Listed in drive
 * order, a whole-app run named 12 of 70 actions and left its failures in "… and 58 more", so the
 * agent reading it could not say what any of them was.
 */
const MAX_FAILED = 40;

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
export const ReplayOutcome = {
  OK: 'ok',
  DRIFT: 'drift',
  ERROR: 'error',
  /** Stopped at a step the flow marks destructive: not run, which is not a regression. */
  GUARDED: 'guarded',
  /** Not saved on this computer: nothing ran, which is not a regression either. */
  MISSING: 'missing',
} as const;

export function replayedFlows(
  toolCalls: readonly ToolOutcome[],
): { name: string; status: string | undefined }[] {
  const out: { name: string; status: string | undefined }[] = [];
  for (const call of toolCalls) {
    if (ReticleTool.FLOW_REPLAY !== call.name) continue;
    const name = asString(asRecord(call.args)['flowName']) ?? 'a flow';
    const result = asRecord(call.result);
    const message =
      asString(asRecord(result['error'])['message']) ?? asString(result['error']) ?? '';
    const status = call.isError ? ReplayOutcome.ERROR : asString(result['status']);
    out.push({
      name,
      status:
        ReplayOutcome.ERROR !== status
          ? status
          : message.includes(DESTRUCTIVE_REFUSAL)
            ? ReplayOutcome.GUARDED
            : message.includes(NO_SUCH_FLOW)
              ? ReplayOutcome.MISSING
              : status,
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

/** The declared consequence: `until`, or `predicate`, its alias on act_and_wait and on assert. */
function untilOf(args: Record<string, unknown>): unknown {
  return args['until'] ?? args['predicate'];
}

/** A `no` on a click whose only claim was a route: the driver's guess, not the app (route-guess.ts). */
function routeGuessMissed(args: Record<string, unknown>, result: Record<string, unknown>): boolean {
  return Verified.NO === result['verified'] && claimsOnlyRoute(untilOf(args));
}

/** The line a re-press graded undecided carries instead of the raw `no`. */
const MSG_REPRESS =
  "a second press of a control whose claim already held: the Harness's own extra action, not the app";

type CheckOutcome = 'held' | 'failed' | 'undecided';

/** One check the drive made, graded: the one derivation every count and step line reads. */
interface GradedCheck {
  /** Its index in the call log. */
  index: number;
  /** What the platform counts a check by: the claim's kind and target. */
  key: string;
  outcome: CheckOutcome;
  /** A `no` on a press whose same claim already held: neutralised to undecided. */
  repress: boolean;
}

/** Every check in drive order: act_and_wait with an `until` and asserts, through reticle_run too. */
function gradedChecks(toolCalls: readonly ToolOutcome[]): GradedCheck[] {
  const heldPresses = new Set<string>();
  const out: GradedCheck[] = [];
  for (const [index, made] of toolCalls.entries()) {
    const call = throughRun(made);
    const args = asRecord(call.args);
    const until = untilOf(args);
    const isCheck =
      ReticleTool.ASSERT === call.name ||
      (ReticleTool.ACT_AND_WAIT === call.name && until !== undefined);
    if (!isCheck || call.isError) continue;
    const result = asRecord(call.result);
    // The driver's own wrong guess about the route checked the driver, not the app.
    if (routeGuessMissed(args, result)) continue;
    const predicate = PredicateSchema.safeParse(until);
    const key = predicate.success
      ? `${predicate.data.kind}|${describeWaitTarget(predicate.data)}`
      : JSON.stringify(until ?? null);
    const verified = asString(result['verified']);
    // A second press of a control whose claim already held is the Harness's own extra action.
    const ref = asString(args['ref']);
    const pressed = ref === undefined ? undefined : `${ref}|${key}`;
    const repress = Verified.NO === verified && pressed !== undefined && heldPresses.has(pressed);
    if (Verified.YES === verified && pressed !== undefined) heldPresses.add(pressed);
    const outcome: CheckOutcome =
      Verified.YES === verified
        ? 'held'
        : Verified.NO === verified && !repress
          ? 'failed'
          : 'undecided';
    out.push({ index, key, outcome, repress });
  }
  return out;
}

/**
 * A `reticle_run` call as the tool it ran. A navigation made through it was recorded under the
 * run's name, and a run that navigated between two pages said it made no action against the app.
 */
function throughRun(call: ToolOutcome): ToolOutcome {
  if (ReticleTool.RUN !== call.name) return call;
  const args = asRecord(call.args);
  const name = asString(args['tool']);
  return name === undefined ? call : { ...call, name, args: asRecord(args['args']) };
}

/** Reduce the raw call log to the actions that actually drove the app. */
export function drivenSteps(toolCalls: readonly ToolOutcome[]): DrivenStep[] {
  const steps: DrivenStep[] = [];
  const represses = new Set(
    gradedChecks(toolCalls)
      .filter((check) => check.repress)
      .map((check) => check.index),
  );
  for (const [index, made] of toolCalls.entries()) {
    const call = throughRun(made);
    if (!DRIVING_TOOLS.has(call.name)) continue;
    const args = asRecord(call.args);
    const result = asRecord(call.result);
    // The gate's refusal never reached the app; listed beside the confirmed retry, it read as "the
    // refund was blocked" to the agent reading this, about a refund that had gone through.
    if (refusedAsDestructive(call)) continue;
    const action =
      ReticleTool.NAVIGATE === call.name ? 'navigate' : (asString(args['action']) ?? 'act');
    const guessMissed = !call.isError && routeGuessMissed(args, result);
    if (represses.has(index)) {
      steps.push({
        action,
        target: targetOf(args, result),
        verified: Verified.UNKNOWN,
        because: MSG_REPRESS,
        claimed: describeClaim(untilOf(args)),
        evidence: [],
      });
      continue;
    }
    // A menu or dialog it opened is the way to the route it named, not a wrong guess.
    const opened = guessMissed && 0 < openedADialog(result, toolCalls.slice(index + 1)).length;
    steps.push({
      ...(guessMissed ? { guess: true as const } : {}),
      action,
      target: targetOf(args, result),
      verified: call.isError
        ? 'error'
        : guessMissed
          ? Verified.UNKNOWN
          : asString(result['verified']),
      because: call.isError
        ? asString(result['error'])
        : opened
          ? MSG_OPENED_MENU
          : guessMissed
            ? MSG_ROUTE_GUESS_MISSED
            : asString(result['because']),
      claimed: describeClaim(untilOf(args)),
      evidence:
        call.isError || opened
          ? []
          : [...evidenceOf(result), ...openedADialog(result, toolCalls.slice(index + 1))],
    });
  }
  return steps;
}

/** Whether the drive did anything to the app: an action that ran, or a flow it replayed. */
export function actedOnApp(toolCalls: readonly ToolOutcome[]): boolean {
  return (
    drivenSteps(toolCalls).some((step) => 'error' !== step.verified) ||
    0 < replayedFlows(toolCalls).length
  );
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
/** Every `__reticle_*` query parameter, wherever it sits in the route. */
const RETICLE_PARAMS = /[?&]__reticle_[^&#]*/g;

/** The pages the drive's own snapshots reported, in order, each distinct page once. */
export function pagesReached(toolCalls: readonly ToolOutcome[]): string[] {
  const pages: string[] = [];
  for (const call of toolCalls) {
    if (ReticleTool.SNAPSHOT !== call.name || call.isError) continue;
    const raw = asString(asRecord(asRecord(call.result)['status'])['route']);
    // Reticle's own parameters (a leased tab's session and project) are not part of the page.
    const route = raw?.replace(RETICLE_PARAMS, '').replace(/^\/\?(?=#|$)/, '/');
    if (route !== undefined && !pages.includes(route)) pages.push(route);
  }
  return pages;
}

/** The values the drive's acts filled or typed, sequence steps included. */
export function typedValues(toolCalls: readonly ToolOutcome[]): string[] {
  const out: string[] = [];
  const read = (act: Record<string, unknown>): void => {
    const inner = asRecord(act['args']);
    const value = asString(inner['value']) ?? asString(inner['text']);
    if (
      value !== undefined &&
      (ActionType.FILL === act['action'] || ActionType.TYPE === act['action'])
    )
      out.push(value);
  };
  for (const call of toolCalls) {
    const steps = call.args['steps'];
    if (Array.isArray(steps)) for (const step of steps) read(asRecord(step));
    else read(call.args);
  }
  return out;
}

/** How the drive's checks came out: act_and_wait with an `until`, and asserts. */
export function checkTally(toolCalls: readonly ToolOutcome[]): {
  held: number;
  failed: number;
  undecided: number;
} {
  // One check per (kind, claim, outcome), exactly as the platform counts a run's checks: a live
  // drive pressed "Sign in" fifteen times and read "15 of 15 check(s) held" for one fact, and an
  // answer that counted by control said "2 of 2" beside a dashboard counting the same run otherwise.
  const seen = new Set<string>();
  const tally = { held: 0, failed: 0, undecided: 0 };
  const count = (key: string, now: CheckOutcome): void => {
    if (seen.has(`${key}|${now}`)) return;
    seen.add(`${key}|${now}`);
    tally[now] += 1;
  };
  for (const check of gradedChecks(toolCalls)) count(check.key, check.outcome);
  // A replayed flow is a check too: its own expects decided it. A passed replay counted as "no
  // check" and its run read NOT PROVED beside a dashboard that said Passed.
  for (const replay of replayedFlows(toolCalls)) {
    const now = REPLAY_CHECK[replay.status ?? ''];
    if (now === undefined) continue;
    count(`${ReticleTool.FLOW_REPLAY}|${replay.name}`, now);
  }
  return tally;
}

/** A replay as a check. Guarded and missing never ran, so they are no check at all. */
const REPLAY_CHECK: Readonly<Record<string, 'held' | 'failed' | 'undecided'>> = {
  [ReplayOutcome.OK]: 'held',
  [ReplayOutcome.ERROR]: 'failed',
  [ReplayOutcome.DRIFT]: 'undecided',
  [ReplayStatus.UNVERIFIABLE]: 'undecided',
};

/** A plan journey's status, as far as the run's verdict reads it. */
export interface JourneyStatus {
  status: string;
}

/**
 * A plan run's verdict is its journeys', decided as the platform decides it (`planRunVerdict`): any
 * failed → failed, else any passed → proved, else nothing proved. Undefined when there is no plan.
 */
function journeysLine(journeys: readonly JourneyStatus[], counts: string): string | undefined {
  if (0 === journeys.length) return undefined;
  const of = (status: string): number => journeys.filter((j) => status === j.status).length;
  const total = String(journeys.length);
  if (0 < of(ScriptStatus.FAILED))
    return `NOT PROVED — ${String(of(ScriptStatus.FAILED))} of ${total} journey(s) failed${counts}.`;
  if (0 < of(ScriptStatus.PASSED))
    return `PROVED — ${String(of(ScriptStatus.PASSED))} of ${total} journey(s) passed${counts}.`;
  return `NOT PROVED — no journey passed${counts}.`;
}

/**
 * The first line a caller reads, and the one the HUD ends on. A drive whose only passing check was
 * a page change, beside a refund that failed, is NOT "proved its checks"; that line ended a run
 * where the journey it was asked to prove had failed.
 */
export function verdictLine(
  tally: { held: number; failed: number; undecided: number },
  goalMet?: boolean,
  /** A plan's journeys: when there are any, their verdict is the run's. */
  journeys: readonly JourneyStatus[] = [],
): string {
  const total = tally.held + tally.failed + tally.undecided;
  const counts = `${String(tally.held)} of ${String(total)} check(s) held, ${String(tally.failed)} failed, ${String(tally.undecided)} undecided`;
  const planned = journeysLine(journeys, 0 === total ? '' : `; ${counts}`);
  // Journeys that passed are not the run's goal reached: the goals the run was asked decide it too.
  if (true === planned?.startsWith('PROVED') && false === goalMet)
    return `NOT PROVED — ${planned.slice('PROVED — '.length).replace(/\.$/, '')}, but the goal was not reached.`;
  if (planned !== undefined) return planned;
  if (0 === total) return 'NOT PROVED: the drive ran no check.';
  if (0 < tally.failed) return `NOT PROVED — ${counts}. The failures below are findings.`;
  if (0 < tally.undecided) return `NOT PROVED — ${counts}.`;
  // Checks that held on the way are not the journey done.
  if (false === goalMet) return `NOT PROVED — ${counts}, but the goal was not reached.`;
  return `PROVED — ${counts}.`;
}

/** Whether the run is proved, exactly as its headline says: the `proved` an answer carries. */
export function runProved(
  tally: { held: number; failed: number; undecided: number },
  goalMet?: boolean,
  journeys: readonly JourneyStatus[] = [],
): boolean {
  return verdictLine(tally, goalMet, journeys).startsWith('PROVED');
}

export function describeDrive(
  toolCalls: readonly ToolOutcome[],
  savedFlows: readonly string[],
  unverifiedFlows: readonly string[] = [],
  goalMet?: boolean,
  journeys: readonly JourneyStatus[] = [],
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
          const guarded = replays.filter((r) => ReplayOutcome.GUARDED === r.status);
          const missing = replays.filter((r) => ReplayOutcome.MISSING === r.status);
          const lines = [
            `Replayed ${String(replays.length)} recorded journey(s) with NO model in the loop: ` +
              `${String(held.length)} still hold, ${String(failed.length)} failed, ${String(drifted.length)} drifted` +
              `${0 === guarded.length ? '' : `, ${String(guarded.length)} not run`}` +
              `${0 === missing.length ? '' : `, ${String(missing.length)} not on this computer`}.`,
          ];
          if (0 < missing.length)
            lines.push(
              `  MISSING: ${missing.map((r) => r.name).join(', ')} — not saved on this computer, or calls a flow that is not, so it never ran. Not a regression: pull or record them here first.`,
            );
          if (0 < failed.length)
            lines.push(
              `  FAILED: ${failed.map((r) => r.name).join(', ')} — regressions in journeys that used to pass.`,
            );
          if (0 < guarded.length)
            lines.push(
              `  NOT RUN: ${guarded.map((r) => r.name).join(', ')} — stopped at a step marked destructive. Not a regression: replay with confirmDangerous to run it.`,
            );
          if (0 < drifted.length)
            lines.push(
              `  DRIFTED: ${drifted.map((r) => r.name).join(', ')} — the app moved under these recordings; the flow needs re-anchoring, not the app fixing.`,
            );
          return lines.join('\n');
        })();

  // A plan run leads with its journeys' verdict even when the model drove nothing: its replays, or
  // a journey a guard stopped, are a result, never "no action against the app".
  if (0 === steps.length) {
    const lead =
      0 === journeys.length ? undefined : verdictLine(checkTally(toolCalls), goalMet, journeys);
    return [
      lead,
      replayLine ??
        (lead === undefined
          ? 'Nothing was driven and nothing was replayed: the run made no action against the app.'
          : undefined),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }

  const proved = steps.filter((step) => Verified.YES === step.verified);
  const failed = steps.filter((step) => Verified.NO === step.verified);
  // The driver's own route guesses are no check (as `checkTally` counts), so not "not decided".
  const guesses = steps.filter((step) => true === step.guess);
  const undecided = steps.filter(
    (step) =>
      true !== step.guess && Verified.YES !== step.verified && Verified.NO !== step.verified,
  );

  const pages = pagesReached(toolCalls);
  const lines: string[] = [
    verdictLine(checkTally(toolCalls), goalMet, journeys),
    ...(replayLine === undefined ? [] : [replayLine]),
    // The outcomes are counted once, in the checks line above: no second breakdown here.
    `Drove ${String(steps.length)} action(s)` +
      (0 === guesses.length ? '.' : `; ${String(guesses.length)} guess of its own, not a check.`),
    // How DEEP it got. An action count reads the same for a checkout walked to its receipt and for
    // eleven clicks on the home page; the pages reached are what tell them apart.
    ...(0 === pages.length
      ? []
      : [`Reached ${String(pages.length)} page(s): ${pages.join(' → ')}.`]),
    ...appFindings(toolCalls),
  ];

  const listed = [...failed, ...proved, ...undecided, ...guesses].slice(
    0,
    Math.max(MAX_LISTED, Math.min(failed.length, MAX_FAILED)),
  );
  for (const step of listed) {
    const verdict = step.verified ?? 'nothing declared';
    const because = step.because === undefined ? '' : ` — ${step.because}`;
    // The claim, on failures only: it is what separates "the app is broken" from "the drive guessed
    // wrong", and those two readings need opposite responses from whoever reads this.
    // Shown on anything that did not pass, not just on a red. `no-fault` means "the consequence was
    // already true, so this proved nothing" -- which is unreadable without knowing WHAT was claimed,
    // and is the line that exposed a GET offer being satisfied by a dashboard's own polling.
    const claimed =
      Verified.YES !== step.verified && step.claimed !== undefined
        ? ` (claimed ${step.claimed})`
        : '';
    lines.push(`  ${step.action} ${step.target}: ${verdict}${claimed}${because}`);
    for (const line of step.evidence) lines.push(`      ${line}`);
  }
  if (listed.length < steps.length) {
    const unlistedFailed = Math.max(0, failed.length - MAX_FAILED);
    lines.push(
      `  … and ${String(steps.length - listed.length)} more` +
        (0 === unlistedFailed
          ? ', none of them failed.'
          : `, ${String(unlistedFailed)} of them failed.`),
    );
  }
  const confirmed = confirmedDestructive(toolCalls);
  if (0 < confirmed)
    lines.push(
      `${String(confirmed)} destructive action(s) were confirmed and REALLY RAN against the app (the drive confirms one only after the gate refuses it; the refusal itself changed nothing).`,
    );

  // Counted from the same graded checks as the checks line, never from the raw step verdicts: an
  // answer read "0 failed" beside "1 action(s) FAILED … These are findings" about one re-press.
  const tally = checkTally(toolCalls);
  if (0 < tally.failed)
    lines.push(
      `${String(tally.failed)} check(s) FAILED — the app did not do what the drive declared it would. These are findings.`,
    );
  if (0 < tally.undecided)
    lines.push(
      `${String(tally.undecided)} check(s) undecided. That is undecided evidence, not a failure: it calls for a better check, not a code change.`,
    );
  const undeclared = undecided.filter((step) => step.claimed === undefined).length;
  if (0 < undeclared)
    lines.push(
      `${String(undeclared)} action(s) declared no consequence, so they prove nothing either way: not a check, not a failure.`,
    );
  // A flow with no step that asserts anything replays as "verified nothing": offered as a replay it
  // reads as evidence, so it is named for what it is instead.
  const empty = new Set(unverifiedFlows);
  const replayable = savedFlows.filter((name) => !empty.has(name));
  if (0 < replayable.length)
    lines.push(
      `Replay any of this without a model: reticle_verify { action: "flows" } — saved ${replayable.join(', ')}.`,
    );
  for (const name of unverifiedFlows)
    lines.push(
      `Saved ${name}, but ${name} checks nothing: no step asserts a consequence, so its replay will verify nothing. Drive again naming the end state, or add an expect to its last step.`,
    );

  return lines.join('\n');
}

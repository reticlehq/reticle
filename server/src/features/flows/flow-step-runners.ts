/**
 * How one anchored step is turned into a live action.
 *
 * Split out of flow-replay.ts when adding the role+name runner pushed that file past the size cap.
 * These three share one shape — resolve an anchor to a ref, then dispatch — and the sharing is the
 * point: the action window must open and close identically no matter which anchor found the element,
 * or a step's events land in the wrong window depending on how it was addressed.
 */
import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  DriftReason,
  QueryBy,
  ReticleCommand,
  type FlowAnchor,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { replayActionArgs } from './replay.js';
import { isStaleRefError } from '../../agent/tools/act-sequence-retry.js';
import { waitForReaction } from '../../agent/tools/react-grace.js';
import { anchorFieldName } from './flows.js';
import type { FlowReplaySession, Sleep } from './flow-replay.js';
import {
  anchorLabel,
  componentLabel,
  componentQueryArgs,
  resolveQuery,
  testidDrift,
} from './flow-replay.js';
import { nearestRoleName, type RoleCandidate } from './role-anchor-nearest.js';
import { roleDriftReason } from './role-drift-reason.js';

/** Query args for a NAMED role anchor — the handle that identifies an instance, not a JSX site. */
function roleQueryArgs(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.ROLE }>,
): Record<string, unknown> {
  return {
    by: QueryBy.ROLE,
    value: anchor.role,
    ...(anchor.name === undefined ? {} : { name: anchor.name }),
  };
}

/** Run one role+name-anchored step: re-resolve via QUERY by:'role', ACT on the live ref, else drift. */
/**
 * The controls actually on the page, as role + name, for the nearest-match scan.
 *
 * Reads the interactive snapshot rather than a second query per candidate: one round trip, and it is
 * the same view the coverage tool uses, so "what is on this page" has one definition.
 */
async function nearestRoleNameOnPage(
  session: FlowReplaySession,
  anchor: { role: string; name?: unknown },
): Promise<string | null> {
  const wanted = 'string' === typeof anchor.name ? anchor.name : undefined;
  if (wanted === undefined) return null;
  try {
    // Straight off the QUERY result: resolveQuery reduces to refs, and the NAMES are what this needs.
    const result = await session.command(ReticleCommand.QUERY, {
      by: QueryBy.ROLE,
      value: anchor.role,
    });
    const payload = result.result;
    const elements =
      'object' === typeof payload && payload !== null
        ? (payload as { elements?: unknown }).elements
        : undefined;
    if (!Array.isArray(elements)) return null;
    const candidates: RoleCandidate[] = elements
      .map((element) =>
        'object' === typeof element && element !== null
          ? (element as { name?: unknown }).name
          : undefined,
      )
      .filter((name): name is string => 'string' === typeof name && name.length > 0)
      .map((name) => ({ role: anchor.role, name }));
    return nearestRoleName(anchor.role, wanted, candidates);
  } catch {
    // A drift report must never fail because the suggestion lookup did.
    return null;
  }
}

export async function runRoleStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.ROLE }>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const label = `${anchor.role} "${String(anchor.name)}"`;
  const { refs } = await resolveQuery(session, roleQueryArgs(anchor), sleep);
  const ref = refs[0];
  if (ref === undefined) {
    // `nearest` used to be the literal null, so heal answered "no nearest match cleared the
    // confidence floor" for EVERY role-anchored drift — a structural limit reported as a judgement
    // about candidates, when nothing had looked. It looks now, and it is deliberately stricter than
    // the testid path: a role name is user-visible text, so a near-match is far more likely to be a
    // different control than a renamed one. A candidate here is INFORMATION for the agent; heal
    // still refuses to rebind a role anchor on its own.
    const nearest = await nearestRoleNameOnPage(session, anchor);
    return {
      step: index,
      tool: step.tool,
      anchor: label,
      ok: false,
      drift: {
        reasonKind: DriftReason.COMPONENT_NOT_FOUND,
        reason: roleDriftReason(anchor.role, String(anchor.name), nearest),
        anchor: label,
        nearest,
      },
    };
  }
  return await actOnResolvedRef(
    session,
    step,
    index,
    label,
    ref,
    confirmDangerous,
    anchorFieldName(anchor),
    // The retry's whole point: run the SAME locator against the DOM as it is now.
    async () => (await resolveQuery(session, roleQueryArgs(anchor), sleep)).refs[0],
  );
}

/**
 * `assertActionAllowed`'s refusal — "potentially destructive action blocked; retry with
 * args.confirmDangerous=true" — is written for a LIVE call, where retrying with that arg works. It
 * does not during replay: `replayActionArgs` deliberately strips any `confirmDangerous` a step's own
 * args carry and restores it only from the ONE call-level boolean this run was given, because a
 * destructive confirmation has to be a decision made for THIS run, never a value saved into the
 * recording (#94). A caller who hand-edits the flow file's step args to add it gets it silently
 * deleted, replays again, and reads the identical refusal — which reads as though nothing they tried
 * worked, when what happened is they tried the one thing that cannot work here.
 *
 * Appends the path that does, rather than replacing the message: an agent that has already learned
 * to recognise the raw refusal still finds it, plus the fix for this specific caller.
 */
const DESTRUCTIVE_ACTION_PATTERN = /potentially destructive (?:\w+ )*(?:action|tool) blocked/i;

export function replayDestructiveActionHint(rawError: string): string {
  if (!DESTRUCTIVE_ACTION_PATTERN.test(rawError)) return rawError;
  return (
    `${rawError} — this is a flow REPLAY: a step's own args.confirmDangerous is stripped before ` +
    'dispatch and never persists, so editing the flow file does nothing. Pass it at the call level ' +
    `instead: ${ReticleTool.FLOW_REPLAY} { confirmDangerous: true } acknowledges every flagged step ` +
    // `reticle_verify{action:"flows"}` (the batch suite runner) has no such argument today — naming
    // it here would repeat the exact defect this message exists to fix, so the honest statement is
    // that a flow with a flagged step currently has to be replayed on its own to pass it.
    'for this run. The batch reticle_verify{action:"flows"} has no equivalent option yet, so a flow ' +
    'with a flagged step has to be replayed on its own to acknowledge it.'
  );
}

/**
 * Dispatch one already-resolved step. Shared so every anchor kind runs the action the same way —
 * including the action window, whose open/close must not depend on which anchor found the element.
 */
async function actOnResolvedRef(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  label: string,
  ref: string,
  confirmDangerous: boolean,
  /**
   * The field name a redacted fill is supplied under, from `anchorFieldName` — the SAME function
   * redaction uses to decide what to hide. Without it a role-anchored secret is redacted at save
   * and looked up at replay under no name at all, so the flow types the placeholder into the form.
   */
  field?: string,
  /**
   * Resolve the anchor again. Supplied by the caller because only it knows how this step's anchor is
   * found, and the retry below is worthless without it: re-dispatching the SAME dead ref fails
   * identically. What changed between the two attempts is the DOM, so the locator has to be run
   * against it again.
   */
  reresolve?: () => Promise<string | undefined>,
): Promise<FlowStepResult> {
  const dispatch = async (at: string): Promise<{ ok: boolean; error?: string | undefined }> => {
    session.beginAction?.(ReticleTool.FLOW_REPLAY, { ref: at, action: step.action ?? '' });
    try {
      const r = await session.command(ReticleCommand.ACT, {
        ref: at,
        action: step.action ?? '',
        args: replayActionArgs(step.args, confirmDangerous, field),
      });
      return { ok: r.ok, error: r.error };
    } finally {
      session.finishAction?.();
    }
  };

  let act = await dispatch(ref);
  /*
   * One retry, and only for staleness.
   *
   * A saved flow of `fill` then `click` failed with "ref 'eNNNN' no longer resolves to an element",
   * a different ref each attempt: the fill re-rendered the page between the click step resolving its
   * element and dispatching at it. `flow_heal` answered `unhealable` and was right — the locator was
   * correct, only the timing was wrong — and the flow format has no way to express a wait, so there
   * was nothing the user could do.
   *
   * `act_sequence` already solved this race for the same reason; the predicate and the grace period
   * come from there rather than being written twice. A step that failed for any OTHER reason is
   * never retried: a replay that quietly repeats actions turns one click into two, which is worse
   * than the failure it papers over.
   */
  if (!act.ok && isStaleRefError(act.error) && reresolve !== undefined) {
    await waitForReaction(session, 0, STALE_REF_GRACE_MS, {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const fresh = await reresolve();
    if (fresh !== undefined) act = await dispatch(fresh);
  }

  const result: FlowStepResult = { step: index, tool: step.tool, anchor: label, ok: act.ok };
  if (!act.ok) result.error = replayDestructiveActionHint(act.error ?? 'command failed');
  return result;
}

/** How long to let the app finish re-rendering before the one retry. Matches the sequence path. */
const STALE_REF_GRACE_MS = 400;

/** Run one component-anchored step: re-resolve via QUERY by:'component', ACT on the live ref, else drift. */
export async function runComponentStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const label = componentLabel(anchor);
  const { refs } = await resolveQuery(session, componentQueryArgs(anchor), sleep);
  if (0 === refs.length) {
    return {
      step: index,
      tool: step.tool,
      anchor: label,
      ok: false,
      drift: {
        reasonKind: DriftReason.COMPONENT_NOT_FOUND,
        reason: `component anchor "${label}" not found`,
        anchor: label,
        nearest: null,
      },
    };
  }
  const ref = refs[0] ?? '';
  // Shared with the role path so both get the same action window AND the same stale-ref retry —
  // this used to dispatch inline, which is how one anchor kind could gain a fix the other lacked.
  return await actOnResolvedRef(
    session,
    step,
    index,
    label,
    ref,
    confirmDangerous,
    anchorFieldName(anchor),
    async () => (await resolveQuery(session, componentQueryArgs(anchor), sleep)).refs[0],
  );
}

/**
 * DEGRADED_ANCHOR_ROLE is a MARKER ("no anchor could be determined"), never a locator.
 *
 * Recognising it is most of the fix: a nameless-ROLE anchor used to fall through to the testid
 * runner, which asked the DOM eight times for a testid literally named "unresolved", found none (it
 * never exists), and reported a MISSING ELEMENT. It then ran edit-distance against the word
 * "unresolved" and offered the nearest testid as a rebind target — which flow_verify printed while
 * flow_heal refused it on confidence. Two tools contradicting each other over a candidate that never
 * meant anything.
 *
 * Both recorders emit this sentinel, so the check belongs here on the replay side, where all of them
 * land.
 */
export function isDegradedAnchor(anchor: FlowAnchor): boolean {
  return (
    anchor.kind === AnchorKind.ROLE &&
    anchor.role === DEGRADED_ANCHOR_ROLE &&
    anchor.name === undefined
  );
}

/** What a step with no resolvable anchor reports, instead of a missing-element story. */
const DEGRADED_STEP_REASON =
  'recorded without a resolvable anchor (no data-testid, no accessible role+name), so it can never ' +
  'resolve on replay — add a data-testid to the element and record this flow again';

export function degradedStepResult(step: FlowStep, index: number, label: string): FlowStepResult {
  return {
    step: index,
    tool: step.tool,
    anchor: label,
    ok: false,
    drift: {
      reasonKind: DriftReason.ANCHOR_DEGRADED,
      reason: DEGRADED_STEP_REASON,
      anchor: label,
      // Deliberately null: the old path produced a nearest match to the WORD "unresolved", which is
      // not a candidate for anything.
      nearest: null,
    },
  };
}

/**
 * QUERY args for an element anchor — null when the anchor addresses no element.
 *
 * Exported for `arriveAtStartPath`, which has to ask "can step 1 resolve where we already are?"
 * before deciding to navigate. Sharing this mapping rather than repeating it keeps that question and
 * the step runner's own resolution asking the same thing of the same anchor.
 */
export function anchorQueryArgs(anchor: FlowAnchor): Record<string, unknown> | null {
  if (anchor.kind === AnchorKind.TESTID) return { by: QueryBy.TESTID, value: anchor.value };
  if (anchor.kind === AnchorKind.COMPONENT) return componentQueryArgs(anchor);
  if (anchor.kind === AnchorKind.ROLE && !isDegradedAnchor(anchor)) return roleQueryArgs(anchor);
  return null;
}

/**
 * Run an act_sequence step: resolve every sub-step's OWN anchor, then dispatch the whole thing as one
 * ACT_SEQUENCE — the same shape `replayProgram` already uses, so a recorded sequence and a saved one
 * execute identically.
 *
 * `replayFlow` had no sequence branch at all. It dispatches on `anchor.kind`, so a saved sequence fell
 * to the testid runner and ran ONE act with `action: ''` (a saved sequence carries no top-level
 * action) — sub-steps 2..n never executed. Fixing the anchor without this would have turned a visible
 * drift into a silent partial replay reporting ok.
 */
export async function runSequenceStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  subs: readonly FlowStep[],
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const live: { ref: string; action: string; args: Record<string, unknown> }[] = [];
  for (const [subIndex, sub] of subs.entries()) {
    const label = `${anchorLabel(sub.anchor)} (sub-step ${String(subIndex)})`;
    const queryArgs = anchorQueryArgs(sub.anchor);
    if (null === queryArgs) return degradedStepResult(step, index, label);
    const { refs, hint } = await resolveQuery(session, queryArgs, sleep);
    const ref = refs[0];
    if (ref === undefined) {
      return {
        step: index,
        tool: step.tool,
        anchor: label,
        ok: false,
        drift:
          sub.anchor.kind === AnchorKind.TESTID
            ? testidDrift(sub.anchor.value, hint)
            : {
                reasonKind: DriftReason.COMPONENT_NOT_FOUND,
                reason: `anchor ${label} not found`,
                anchor: label,
                nearest: null,
              },
      };
    }
    live.push({
      ref,
      action: sub.action ?? '',
      // Each sub-step carries its OWN anchor, so each gets its own field name. A sequence that ends
      // in a login is the shape this was reported on, and the sub-step is where the fill lives.
      args: replayActionArgs(sub.args, confirmDangerous, anchorFieldName(sub.anchor)),
    });
  }
  session.beginAction?.(ReticleTool.FLOW_REPLAY, { steps: live.length });
  let act;
  try {
    act = await session.command(ReticleCommand.ACT_SEQUENCE, { steps: live });
  } finally {
    session.finishAction?.();
  }
  const result: FlowStepResult = {
    step: index,
    tool: step.tool,
    anchor: anchorLabel(step.anchor),
    ok: act.ok,
  };
  if (!act.ok) result.error = replayDestructiveActionHint(act.error ?? 'command failed');
  return result;
}

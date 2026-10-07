/**
 * How one anchored step is turned into a live action.
 *
 * Split out of flow-replay.ts when adding the role+name runner pushed that file past the size cap.
 * These three share one shape — resolve an anchor to a ref, then dispatch — and the sharing is the
 * point: the action window must open and close identically no matter which anchor found the element,
 * or a step's events land in the wrong window depending on how it was addressed.
 */
import { expectedElementTestid } from '@reticlehq/core';
import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  DriftReason,
  PredicateKind,
  QueryBy,
  ReplayStatus,
  ReticleCommand,
  type FlowAnchor,
  type FlowReplayResult,
  type FlowStep,
  type FlowStepResult,
  type Predicate,
} from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { replayActionArgs } from './replay.js';
import { isStaleRefError } from '@/surface/tools/act/act-sequence-retry.js';
import { waitForReaction } from '@/surface/tools/act/react-grace.js';
import { anchorFieldName } from './flows.js';
import type { FlowReplaySession, Sleep } from './flow-replay-types.js';
import {
  ambiguityDrift,
  refFor,
  anchorLabel,
  componentLabel,
  componentQueryArgs,
  expectElementDrift,
  reresolved,
  resolveQuery,
  testidDrift,
  type Reresolved,
} from './flow-anchor.js';
import { nearestRoleName, type RoleCandidate } from './role-anchor-nearest.js';
import { roleDriftReason } from '@/judgement/outcome/role-drift-reason.js';

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
  /*
   * More than one match is DRIFT, not a guess. This path took `refs[0]`, dispatched, and returned
   * `ok: true`, so a flow recorded against "View result" on row 3 of a table replayed by clicking row
   * 1 and PASSED whenever every row shared the consequence (the same GET returning 200). The verdict
   * reads `drift` and `ok` and nothing else, so a green here is indistinguishable from a replay that
   * did what it did before.
   *
   * A role+name anchor is MORE likely to land here than a testid is: `button "View result"` is
   * user-visible text, and a table repeats it by nature, so several matches is the expected shape of
   * a recorded row action rather than an accident.
   *
   * The check itself lives in `ambiguityDrift`, shared with the testid and component runners: written
   * per-runner, this rule got applied to two anchor kinds and forgotten for the third.
   */
  const ambiguous = ambiguityDrift(anchor, refs);
  if (ambiguous !== null) {
    return { step: index, tool: step.tool, anchor: label, ok: false, drift: ambiguous };
  }
  const ref = refFor(anchor, refs);
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
    /*
     * The retry's whole point: run the SAME locator against the DOM as it is now.
     *
     * It reports WHAT it found, not just a ref. A re-render can turn an unambiguous anchor into an
     * ambiguous one between the two dispatches, and dispatching at the first of the new matches would
     * re-make the guess the check above exists to refuse — one layer deeper, where the caller cannot
     * see it. `reresolved` is the same rule as that check, so the two cannot disagree.
     */
    async () =>
      reresolved(anchor, (await resolveQuery(session, roleQueryArgs(anchor), sleep)).refs),
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

function replayDestructiveActionHint(rawError: string): string {
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
export async function actOnResolvedRef(
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
   *
   * It reports WHAT it found, not just a ref: see `Reresolved`. A re-render that turns one match into
   * three is a drift, and the caller is the only layer that can say so with the right anchor in hand.
   */
  reresolve?: () => Promise<Reresolved | undefined>,
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
    /*
     * The re-render turned one match into SEVERAL, so there is nothing to dispatch at and the answer
     * is a drift — the same `anchor_ambiguous` the first resolution would have given, reported for the
     * same reason.
     *
     * The staleness this retry exists to absorb is a different diagnosis with a different fix, and
     * this used to be the only one reported: the step came back as `{ok: false, error: "ref 'e-orig'
     * no longer resolves to an element"}` — a sentence about an element that is GONE, sent for an
     * element that is now three. An agent reading it goes hunting for a rename, or re-records the
     * flow, when the actual fix is a narrower anchor. Telling the two apart is what `Reresolved` is
     * for, and the reason `ANCHOR_AMBIGUOUS` exists as its own kind rather than folding into "not
     * found".
     */
    if (fresh !== undefined && 'drift' in fresh) {
      return { step: index, tool: step.tool, anchor: label, ok: false, drift: fresh.drift };
    }
    if (fresh !== undefined) act = await dispatch(fresh.ref);
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
  /*
   * Several matches is DRIFT here too, and this runner is where the rule was MISSING.
   *
   * The other two runners check it (through `ambiguityDrift`); this one took `refs[0]`, dispatched and
   * returned `ok: true`. `by: QueryBy.COMPONENT` matches by component NAME, and a component rendered
   * once per row — a table's action button, a card's menu — matches as many times as there are rows.
   * So the guessed-green shape is not an edge case for this anchor kind, it is its ordinary one, and
   * it is the exact defect #1227 describes: a click on the wrong element reported as a pass because
   * the verdict reads `drift` and `ok` and never reads which element was hit.
   */
  const ambiguous = ambiguityDrift(anchor, refs);
  if (ambiguous !== null) {
    return { step: index, tool: step.tool, anchor: label, ok: false, drift: ambiguous };
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
    // Same rule one layer deeper, same helper: a re-render that turns one match into three must not
    // be dispatched at either, and it must say so as a drift rather than as a dead ref. This callback
    // used to return `refs[0]` unconditionally.
    async () =>
      reresolved(anchor, (await resolveQuery(session, componentQueryArgs(anchor), sleep)).refs),
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
 * The anchor as a PRECONDITION a flow file can store: "this element is on the page".
 *
 * What `requires` means for a flow that starts from state a page load discards, in the shape the
 * flow's own `requires` holds. No tool writes `requires`, so the reset's hint hands over this line.
 */
export function anchorPrecondition(anchor: FlowAnchor): Predicate | undefined {
  if (anchor.kind === AnchorKind.TESTID) {
    return { kind: PredicateKind.ELEMENT, query: { testid: anchor.value } };
  }
  if (anchor.kind === AnchorKind.ROLE && !isDegradedAnchor(anchor)) {
    return { kind: PredicateKind.ELEMENT, query: { role: anchor.role, name: anchor.name } };
  }
  return undefined;
}

/** What is added to a stale-ref error when it cannot be traced to one sub-step of the sequence. */
const STALE_SUB_STEP_UNKNOWN =
  ' (which sub-step that was could not be told, so the ones before it may have run)';

/** Where a ref that stayed stale sat in the sequence, and that every sub-step before it ran. */
const staleSubStepPosition = (at: number, total: number): string =>
  ` (sub-step ${String(at)} of ${String(total)}; ${String(at)} before it ran)`;

/**
 * Why a step whose target kept going stale is unverifiable, as the replay result tells a reader.
 * `step` is the index of the step that could not be acted on.
 */
const staleTargetReason = (step: number): string =>
  `step ${String(step)} could not be acted on: its target kept going stale, because the ` +
  `page re-rendered between finding the element and using it, and the replay looked it up ` +
  `again for as long as that got it further. The steps before it are reported and nothing ` +
  `after it ran. Nothing here says the app failed. If an earlier step makes the page ` +
  `re-render, record that step's consequence with \`expect\` so the replay waits for the new ` +
  `render before it moves on.`;

/**
 * The sub-step, among live[from, to), whose ref the page said it could not find.
 *
 * The page echoes the ref in "ref 'x' no longer resolves to an element". A ref it shortened, or one
 * that is not among these, gives no answer. Neither does a ref that two sub-steps share: the first of
 * them may already have run, and may be what re-rendered the page, which makes the later one the stale
 * one, and nothing in the message says so. The caller must not guess which actions already ran.
 */
function staleSubStep(
  error: string,
  live: readonly { ref: string }[],
  from: number,
  to: number,
): number | undefined {
  const named = /ref '([^']*)'/.exec(error)?.[1];
  if (named === undefined) return undefined;
  const sharing = live.flatMap((one, at) =>
    at >= from && at < to && one.ref === named ? [at] : [],
  );
  const [only] = sharing;
  return 1 === sharing.length ? only : undefined;
}

/**
 * The honest answer when a step's target kept going stale.
 *
 * Replay looks the element up again and goes on while that gets it further, so a step still stale
 * after that is one the page re-rendered around faster than it could be targeted. Reporting it as
 * `error` with the browser's own sentence says "your app broke", which is a claim nothing observed
 * and sends a reader into product code that is fine. It is the same bucket as a document that went
 * away: the steps before it are real and are attached, the step that could not be acted on is among
 * them with its index, and nothing after it ran.
 *
 * Left alone, so the ordinary verdict stands, when anything else is in the run: a drifted anchor is
 * drift whatever else happened, and a failure that is not staleness is a failure.
 */
export function staleTargetResult(
  name: string,
  steps: readonly FlowStepResult[],
): FlowReplayResult | undefined {
  if (steps.some((step) => step.drift !== undefined)) return undefined;
  const failed = steps.filter((step) => !step.ok);
  const [only] = failed;
  if (failed.length !== 1 || only === undefined || !isStaleRefError(only.error)) return undefined;
  return {
    name,
    status: ReplayStatus.UNVERIFIABLE,
    steps: [...steps],
    unverifiable: { reason: staleTargetReason(only.step) },
  };
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
  /** Testids whose presence is deliberately NOT asserted — the LLM-output case. */
  dynamic: ReadonlySet<string> = new Set(),
): Promise<FlowStepResult> {
  type LiveSubStep = { ref: string; action: string; args: Record<string, unknown> };

  /**
   * Find one sub-step's element as the page is NOW. Either the live step to dispatch, or the step
   * result that ends the run: a degraded anchor, or one that is no longer on the page.
   *
   * `afterRerender` is the second look, taken because the page re-rendered under a sub-step. An anchor
   * that now matches several elements is drift there, as it is for a single step's retry: the first of
   * the new matches may be an element the recording did not mean, and acting on it would report a pass
   * for a click nobody can attribute. The first look keeps taking the first match.
   */
  const resolveSub = async (
    sub: FlowStep,
    subIndex: number,
    afterRerender = false,
  ): Promise<{ live: LiveSubStep } | { stop: FlowStepResult }> => {
    const label = `${anchorLabel(sub.anchor)} (sub-step ${String(subIndex)})`;
    const queryArgs = anchorQueryArgs(sub.anchor);
    if (null === queryArgs) return { stop: degradedStepResult(step, index, label) };
    const { refs, hint } = await resolveQuery(session, queryArgs, sleep);
    const ambiguous = afterRerender ? ambiguityDrift(sub.anchor, refs) : null;
    if (ambiguous !== null) {
      return { stop: { step: index, tool: step.tool, anchor: label, ok: false, drift: ambiguous } };
    }
    const ref = afterRerender ? refFor(sub.anchor, refs) : refs[0];
    if (ref === undefined) {
      return {
        stop: {
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
        },
      };
    }
    return {
      live: {
        ref,
        action: sub.action ?? '',
        // Each sub-step carries its OWN anchor, so each gets its own field name. A sequence that ends
        // in a login is the shape this was reported on, and the sub-step is where the fill lives.
        args: replayActionArgs(sub.args, confirmDangerous, anchorFieldName(sub.anchor)),
      },
    };
  };

  // Every anchor is checked before anything runs, so a sub-step that has drifted away is reported as
  // drift and not discovered half way through a sequence that has already acted.
  const live: LiveSubStep[] = [];
  for (const [subIndex, sub] of subs.entries()) {
    const resolved = await resolveSub(sub, subIndex);
    if ('stop' in resolved) return resolved.stop;
    live.push(resolved.live);
  }
  const result: FlowStepResult = {
    step: index,
    tool: step.tool,
    anchor: anchorLabel(step.anchor),
    ok: true,
  };

  /** One dispatch through the SAME command either way, so batched and walked replay identically. */
  const send = async (
    steps: readonly LiveSubStep[],
  ): Promise<Awaited<ReturnType<typeof session.command>>> => {
    session.beginAction?.(ReticleTool.FLOW_REPLAY, { steps: steps.length });
    try {
      return await session.command(ReticleCommand.ACT_SEQUENCE, { steps });
    } finally {
      session.finishAction?.();
    }
  };

  /**
   * Run sub-steps [from, to), and survive the page re-rendering under them.
   *
   * The refs were resolved before anything ran, and the first action of a sequence is allowed to
   * re-render the page, so by the time a later sub-step is reached its ref may be dead. The same
   * anchor is almost always still there under a new ref; what was missing is a second look.
   *
   * The page names the ref it could not find, which says WHICH sub-step failed and so which ones
   * already ran, as long as no other sub-step holds the same ref. Only the rest is resolved again and
   * sent, so nothing acts twice: starting over is what turns one click into two. A stale ref is the
   * only failure retried, and the retry goes on only while it gets further. A sub-step that is stale
   * again at the same point is a target that does not hold still, and the run says so, with how far
   * it got.
   */
  const dispatchFrom = async (from: number, to: number): Promise<boolean> => {
    let start = from;
    let staleBefore = -1;
    for (;;) {
      const act = await send(live.slice(start, to));
      if (act.ok) return true;
      const error = act.error ?? 'command failed';
      if (!isStaleRefError(error)) {
        result.ok = false;
        result.error = replayDestructiveActionHint(error);
        return false;
      }
      const staleAt = staleSubStep(error, live, start, to);
      if (staleAt === undefined) {
        result.ok = false;
        result.error = error + STALE_SUB_STEP_UNKNOWN;
        return false;
      }
      if (staleAt <= staleBefore) {
        result.ok = false;
        result.error = error + staleSubStepPosition(staleAt, subs.length);
        return false;
      }
      staleBefore = staleAt;
      await waitForReaction(session, 0, STALE_REF_GRACE_MS, { sleep });
      for (let at = staleAt; at < to; at += 1) {
        const sub = subs[at];
        if (sub === undefined) continue;
        const resolved = await resolveSub(sub, at, true);
        if ('stop' in resolved) {
          result.ok = false;
          result.anchor = resolved.stop.anchor;
          if (resolved.stop.drift !== undefined) result.drift = resolved.stop.drift;
          return false;
        }
        live[at] = resolved.live;
      }
      start = staleAt;
    }
  };

  /** The sub-step's own expectation, unless its testid is deliberately unasserted. */
  const declaredBy = (sub: FlowStep): string | undefined => {
    const testid = expectedElementTestid(sub.expect);
    return testid === undefined || dynamic.has(testid) ? undefined : testid;
  };

  /**
   * Assert one sub-step's expectation. Absence stops the sequence.
   *
   * The STEP's anchor is named, not the assertion's target: replay stops at the first drift, and
   * naming the expectation here would read as "this step's locator drifted" on a step whose locator
   * resolved and whose action fired.
   */
  const assertDeclared = async (testid: string): Promise<boolean> => {
    const found = await resolveQuery(session, { by: QueryBy.TESTID, value: testid }, sleep);
    if (0 < found.refs.length) return true;
    result.ok = false;
    result.drift = expectElementDrift(testid, found.hint);
    return false;
  };

  /*
   * A sequence that declares nothing goes as ONE batch — the cheap path, and the common one.
   *
   * When a sub-step DOES declare, the sub-steps are walked and each expectation is checked right
   * after its own action. Checking them all at the end, which is what replay used to do, let "click
   * Pay, and the receipt appears" pass because a LATER sub-step produced the receipt: true by the
   * time anybody looked, and no longer a claim about this action. The live act path never had that
   * hole, because it asserts before moving on; this is replay catching up to it.
   *
   * The walk costs a round trip per sub-step, so only a flow that declared something pays for it.
   */
  const declaring = subs.some((sub) => declaredBy(sub) !== undefined);
  if (!declaring) {
    await dispatchFrom(0, live.length);
    return result;
  }
  for (const [subIndex, sub] of subs.entries()) {
    if (live[subIndex] === undefined) continue;
    if (!(await dispatchFrom(subIndex, subIndex + 1))) return result;
    const testid = declaredBy(sub);
    if (testid !== undefined && !(await assertDeclared(testid))) return result;
  }
  return result;
}

import { normalizeQueryArgs } from './query-shape.js';
import type { Session } from '../session/session.js';
import { resolveTargetRef, type TargetResolution } from './resolve-target.js';
/**
 * Action tools — reticle_act, reticle_act_sequence, reticle_act_and_wait. Split out of tools.ts to keep
 * that file under the line cap and assembled back into the tool list there via ...ACT_TOOLS; the
 * native-input attempt itself lives in real-input-attempt.ts for the same reason.
 */
import { z } from 'zod';
import { aliasParam } from './alias-args.js';
import { captureAct, compileSequenceStep } from '../flows/replay.js';
import {
  ActionType,
  ActionWarning,
  CaptureLoss,
  DEFAULT_ASSERT_TIMEOUT_MS,
  InputMode,
  ReticleCommand,
  Verified,
  VerifiedReason,
  PredicateKind,
  type JournalVerdictEffect,
} from '@reticlehq/core';
import { assertNativeInputSupported } from './act-danger.js';
import { leanActResult, mutatedWithin } from './act-view.js';
import { ReticleTool } from './tool-names.js';
import { buildReactionReport, summarizeReaction } from '../events/reaction.js';
import { parsePredicate } from '../events/predicate-parse.js';
import { causalSummary } from '../capsule/causal-summary.js';
import { findContradictions } from '../events/contradictions.js';
import { gapsForAction } from '../honesty/instrumentation-gaps.js';
import { noteSessionGaps } from '../honesty/gap-ledger.js';
import { isChangeUndeclared } from '../honesty/undeclared-change.js';
import { openSessionIntents } from '../intent/open-intents.js';
import {
  dischargeInlineIntent,
  inlineVerdictId,
  linkInlineIntent,
} from '../intent/inline-intent.js';
import { declaresState } from '../events/predicate-asks.js';
import { isStateUnwatched } from '../honesty/blind-spots.js';
import {
  inFlightRequestLabels,
  repeatedRequestLabels,
  waitForInFlight,
} from './settle-in-flight.js';
import { waitForReaction } from './react-grace.js';
import { decideVerified } from '../honesty/verified.js';
import { declaredExpectations, declaresBodyIndependentChannel } from '../events/declared.js';
import { readsDomState } from '../honesty/already-true.js';
import { describeWaitTarget } from '../honesty/unsettled.js';
import { saveFailedAssertCapsule } from './act-capsule.js';
import { buildDivergenceCapsule } from '../capsule/capsule.js';
import { predicateToExpectedLinks } from '../capsule/predicate-to-links.js';
import { buildHonestyBlock } from '../honesty/honesty.js';
import {
  absenceBlindSpotNote,
  buildCoverageStatement,
  blindSpotsFromState,
  transportGapNote,
  Coverage,
  impeachesCapture,
} from '../honesty/blind-spots.js';
import { hasAcceptedWrite } from '../honesty/accepted-write.js';
import { unreadWriteLabels } from '../honesty/unread-outcome.js';
import {
  evaluatePredicate,
  waitForPredicate,
  provenExpectedLinks,
  PredicateSchema,
} from '../events/predicate.js';
import { awaitDocumentSuccessor } from '../session/session-successor.js';
import { healthEnvelope, refuseIfThrottled } from '../session/session-health.js';
import {
  pausedShortCircuit,
  pausedOutputShape,
  withControl,
  PAUSED_NO_VERDICT,
} from '../session/control-envelope.js';
import { asString, asNumber, asRecord, sourceOf } from './tools-helpers.js';
import { type ToolDef, intentArg, sessionIdShape } from './tool-kit.js';
import { asActionType, gradeOf } from './act-helpers.js';
import { tryRealInput, rewriteUploadArgs } from './real-input-attempt.js';

/**
 * Single dispatch point for every ACT and ACT_SEQUENCE command.
 *
 * This is the seam the reviewer asked for: instead of wiring rewriteUploadArgs at three separate
 * call sites (reticle_act, reticle_act_and_wait, reticle_act_sequence) we intercept once here,
 * which also covers flow-replay, crawl, and any future dispatch site that goes through this helper.
 *
 * captureAct is called AFTER this, so the flow-recording captures the pre-rewrite args (the path
 * the agent actually wrote) rather than the base64 blob — replay would otherwise send 750 KiB of
 * base64 to the browser as if it were an inline content call.
 */
async function actCommand(
  deps: Parameters<typeof rewriteUploadArgs>[0],
  session: {
    command: (
      name: string,
      args: Record<string, unknown>,
      timeout?: number,
    ) => Promise<import('@reticlehq/core').CommandResult>;
  },
  actArgs: Record<string, unknown>,
  timeoutMs?: number,
): Promise<import('@reticlehq/core').CommandResult> {
  const rewritten = await rewriteUploadArgs(
    deps,
    'string' === typeof actArgs['action'] ? actArgs['action'] : '',
    asRecord(actArgs['args']),
  );
  const bridgeArgs: Record<string, unknown> = { ...actArgs, args: rewritten };
  return timeoutMs !== undefined
    ? session.command(ReticleCommand.ACT, bridgeArgs, timeoutMs)
    : session.command(ReticleCommand.ACT, bridgeArgs);
}

/**
 * Narrow the wire's `action` to a real ActionType, or undefined.
 *
 * It used to be `asString(args['action']) ?? ''`, so an unknown or missing action became the empty
 * string and travelled on — reaching the browser as a command it could not perform, and reported back
 * as a generic failure rather than "that is not an action". Validate at the boundary, per the project's
 * unknown-plus-narrowing rule, so a typo is rejected where it can still be explained.
 */

/**
 * The action vocabulary, derived from ActionType — never retyped.
 *
 * The description used to list thirteen actions while ActionType had seventeen: blur, upload, drag
 * and webmcp were real, callable, and undocumented, because a hand-copied list drifts the moment
 * someone adds an arm. Deriving both the schema and the prose from the enum makes that impossible.
 *
 * The handler already refused an unknown action with a good message; the schema now refuses it
 * one layer earlier, before any session is resolved or any work is done.
 */
const ACTION_TYPE_VALUES = Object.values(ActionType);
const ACTION_TYPE_LIST = ACTION_TYPE_VALUES.join(' | ');
const actionTypeEnum = z.enum(ACTION_TYPE_VALUES as [string, ...string[]]);

/**
 * Resolve an action's element: an explicit `ref`, or a `target` query resolved in the SAME call.
 *
 * Requiring a ref meant every verification paid a `reticle_query` turn first just to learn one
 * string, and the advertised tool surface is re-sent on every turn — measured on the wire, a
 * two-turn verification spent 10,756 of 11,235 tokens on schema and 479 on the actual answers. The
 * lookup still happens; it just stops costing a round trip through the model.
 *
 * `ref` wins when both are given, because it is the more specific instruction and silently
 * preferring the query would act on something the caller did not name.
 */
async function resolveActTarget(
  session: Session,
  args: Record<string, unknown>,
): Promise<TargetResolution> {
  const ref = asString(args['ref']);
  if (ref !== undefined && ref.length > 0) return { kind: 'ref', ref };
  const target = args['target'];
  if (target === undefined) {
    return {
      kind: 'error',
      message:
        'pass `ref` (from reticle_query/reticle_snapshot) or `target` (e.g. { testid } or { role, name }).',
    };
  }
  const q = normalizeQueryArgs(asRecord(target));
  const out = await session.command(ReticleCommand.QUERY, {
    by: q['by'],
    value: q['value'],
    name: q['name'],
    scope: q['scope'],
  });
  if (!out.ok) return { kind: 'error', message: out.error ?? 'target query failed' };
  const elements = asRecord(out.result)['elements'];
  return resolveTargetRef(Array.isArray(elements) ? elements : []);
}

export const ACT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.ACT,
    example: { ref: 'e42', action: 'fill', args: { value: 'hello' } },
    description:
      'Act WITHOUT checking the result — if the action is supposed to cause something, use reticle_act_and_wait { until } instead and get the verdict in the same call. This tool returns immediately with a `since` cursor; observe the reaction yourself with reticle_observe. Use it for actions with no observable consequence to assert (focus, hover, scrollIntoView, a fill you are about to submit). One action against a ref: click|dblclick|hover|focus|fill|type|clear|select|check|uncheck|submit|press|scrollIntoView. Carries effect:{dispatched,targetMatched,visible,enabled,focusMoved,valueChanged,domMutatedWithin,occluded,occludedBy,scrolledIntoView} to tell "action missed" from "app didn\'t react"; dispatched=landed, settled=a real frame flushed, and a settle timeout never fails the tool. Fields at their uninformative default are OMITTED so a clean action collapses to its consequence: an absent dispatched/targetMatched/visible/enabled means true, an absent occluded/scrolledIntoView/valueChanged/defaultPrevented means false, an absent focusMoved/occludedBy means null. occluded=true means the click point is covered by another element (a real user could not click it) — synthetic dispatch still delivered the event; scrolledIntoView=true means an off-viewport target was scrolled in first. effect.alreadyAtValue=true (check/uncheck only) means the box already read as the requested state, so NOTHING was dispatched and the app was never told — the DOM property is not evidence the application holds that value, so assert the app\'s own state (a signal, a request, a derived control), not the box. inputMode is "real" (native CDP, no synthetic effect block) or "synthetic"; clicks default to the occlusion-honest synthetic path even when CDP is configured — pass args.native:true to force a trusted native click (file pickers, clipboard). args.holdMs keeps the pointer DOWN for that long between mousedown and mouseup — the only way to drive a hold-to-confirm control (hold-to-delete, hold-to-record, long-press); effect.heldMs reports the hold actually achieved, which a throttled background tab can stretch. args.confirmDangerous is a permission gate and NOT a duration: it allows a destructive control, it does not hold one. inputModeReason explains any real→synthetic choice so it is never silent. Full model (real-input, throttled tabs, `reticle drive`): node_modules/@reticlehq/server/docs/usage.md §18.',
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe(
          `Element ref (e.g. 'e42') from reticle_snapshot/reticle_query — stable until the element leaves the DOM, so no re-snapshot between actions. Give this OR \`target\`.`,
        ),
      target: z
        .record(z.unknown())
        .optional()
        .describe(
          'Find the element and act on it in ONE call, instead of a reticle_query round trip first: { testid } | { text } | { role, name } | { label }. Refuses if it matches more than one, rather than guessing.',
        ),
      action: actionTypeEnum.describe(`Action to perform: ${ACTION_TYPE_LIST}`),
      args: z
        .record(z.unknown())
        .optional()
        .describe(
          'Action-specific arguments: { value } for fill/select, { text } for type/press (the key NAME, e.g. Escape or Tab), { modifiers: ["Meta","Shift"] } for a press shortcut (Meta/Control/Shift/Alt — a Cmd+K), { toRef } for drag (the ref to drop ON — without it the drag lands nowhere), { native: true } to force a trusted native click, { holdMs: N } to keep the pointer DOWN for N ms (hold-to-confirm controls; effect.heldMs reports what was achieved), { confirmDangerous: true } to allow a potentially destructive control — a permission gate, NOT a duration. For upload: { path } is a path on disk (absolute or relative to the project root; the daemon reads the file and delivers real bytes to the file picker — this is the way to verify document-ingestion flows); or { name, content?, type? } to supply inline bytes directly.',
        ),
      refuseWhenThrottled: z
        .boolean()
        .optional()
        .describe(
          'Throw instead of silently sending synthetic events when the tab is throttled/backgrounded. Default: false (synthetic events are still sent).',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      since: z
        .number()
        .describe(
          'Cursor — pass to reticle_observe/reticle_wait_for/reticle_assert to scope reaction queries to this act.',
        ),
      dispatched: z.boolean(),
      settled: z.boolean().nullable(),
      inputMode: z.string(),
      // Diagnostic fields the handler splices — declared so schema-strict clients keep them.
      effect: z.unknown().optional(),
      settleReason: z.unknown().nullable().optional(),
      inputModeReason: z.string().optional(),
      warning: z.string().optional(),
      result: z.unknown().optional(),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
      // This tool short-circuits to pausedShortCircuit while the human has paused; declare its fields
      // or the whole pause payload — including drained-once guidance — is stripped on validating clients.
      ...pausedOutputShape,
    },
    handler: async (deps, args) => {
      // Validate the REQUEST before touching a session: a malformed action is the caller's error and
      // should be reported as such, not after resolving a session and marking an act cursor.
      const action = asActionType(args['action']);
      if (action === undefined) {
        throw new Error(
          `unknown action '${String(args['action'])}' — expected one of: ${Object.values(ActionType).join(', ')}`,
        );
      }
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // Live-control: refuse to drive the page while the human has paused us (before any work).
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      refuseIfThrottled(session, args['refuseWhenThrottled']);
      // Resolve `target` to a ref BEFORE the action window opens, so the lookup is not attributed to
      // the act and cannot be mistaken for something the action caused.
      const targetRef = await resolveActTarget(session, args);
      if ('error' === targetRef.kind) throw new Error(targetRef.message);

      const since = session.elapsed();
      // The act cursor + effect are marked only once the action has actually DISPATCHED (below, on
      // each success path) — a refused act must leave nothing behind for the next observe to judge.
      const ref = targetRef.ref;

      // Open the journal's action-attribution window BEFORE dispatching, so it covers the native path
      // too. It used to open only on the synthetic path, and the native path returned above it — so a
      // hover, a drag or any native:true click produced events with no actionId. Session.pushEvent
      // treats an unattributed ref-bearing event as ambient background churn, so an action's OWN
      // effects were learned as noise; past the ambient threshold the settle oracle then filtered that
      // region out entirely and reported settled while the app was still working. A false green
      // manufactured by the machinery that exists to prevent false greens.
      session.beginAction(ReticleTool.ACT, asRecord(args));
      let settledOutcome: boolean | undefined;
      try {
        // drive native pointer input when a provider is available; otherwise fall back.
        const real = await tryRealInput(deps, session, ref, action, args);
        if (real.result !== undefined) {
          captureAct(deps.recordings, args, real.result);
          settledOutcome = real.settled ?? undefined;
          // Native input reports no synthetic effect block, so nothing measured in-target: undefined
          // (the weaker empty-window test), never a fabricated zero.
          session.lastAct.markActed(since, action, undefined, asString(args['ref']));
          return withControl(session, {
            since,
            inputMode: InputMode.REAL,
            dispatched: true,
            settled: real.settled,
            settleReason: null,
            result: leanActResult(real.result),
            ...healthEnvelope(session),
          });
        }

        // actCommand is the single interception point: it rewrites upload+path args to real bytes
        // before any ACT command crosses the bridge, covering this call site and all others.
        const result = await actCommand(deps, session, {
          ref: targetRef.ref,
          action: args['action'],
          args: args['args'] ?? {},
        });
        if (!result.ok) throw new Error(result.error ?? 'act failed');
        captureAct(deps.recordings, args, result.result);
        // lift dispatch/settle status to the envelope (a settle timeout is NOT a failure).
        const r = asRecord(result.result);
        if ('boolean' === typeof r['settled']) settledOutcome = r['settled'];
        // Keep what only this call measured, so the observe that judges this window can ask whether
        // anything happened INSIDE the target — the one fact that separates a dead control from a
        // page that was merely busy with something else.
        session.lastAct.markActed(since, action, mutatedWithin(r), asString(args['ref']));
        return withControl(session, {
          since,
          inputMode: InputMode.SYNTHETIC,
          // #2: never a silent real→synthetic fallback — say WHY (unless real input isn't configured).
          ...(real.reason !== undefined ? { inputModeReason: real.reason } : {}),
          dispatched: r['dispatched'] ?? true,
          settled: r['settled'] ?? null,
          settleReason: r['settleReason'] ?? null,
          result: leanActResult(result.result),
          ...(true === real.fellBack ? { warning: ActionWarning.REAL_INPUT_FELL_BACK } : {}),
          ...healthEnvelope(session),
        });
      } finally {
        // Close the window on every exit (settle or throw), recording the action + settle outcome.
        session.finishAction(
          undefined,
          settledOutcome,
          true === settledOutcome ? session.elapsed() - since : undefined,
        );
      }
    },
  },
  {
    name: ReticleTool.ACT_SEQUENCE,
    // The example is required for a core tool, and this one carries weight: the measured loop it
    // replaces is literally a login form driven as three separate reticle_act calls (98 clicks and
    // 21 fills inside looping sessions, 2026-08-10/11). Showing fill -> fill -> click is showing the
    // exact shape an agent otherwise spends three round trips on.
    example: {
      steps: [
        { ref: 'e12', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e13', action: 'fill', args: { value: 'hunter2' } },
        { ref: 'e14', action: 'click' },
      ],
    },
    description:
      'Run multiple actions in order (fill -> fill -> submit) in ONE round-trip. Prefer this over repeating reticle_act for a multi-step journey, then assert its consequence once. Returns per-step effects[] (see reticle_act).',
    inputSchema: {
      steps: z
        .array(z.record(z.unknown()))
        .describe(
          'Ordered list of { ref, action, args? } objects. Each step is equivalent to one reticle_act call; put confirmDangerous:true in a destructive step args object.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Per-step timeout in milliseconds. Default: 8000. Each step gets this budget independently.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      since: z.number(),
      dispatched: z.boolean(),
      completed: z.number(),
      stalled_at: z.number().optional(),
      steps: z.array(z.record(z.unknown())).optional(),
      result: z.unknown().optional(),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
      // Short-circuits to pausedShortCircuit while paused — declare its fields (drained-once guidance).
      ...pausedOutputShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      const since = session.elapsed();
      session.beginAction(ReticleTool.ACT_SEQUENCE, asRecord(args));
      try {
        const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
        const perStepTimeout = 'number' === typeof args['timeout_ms'] ? args['timeout_ms'] : 8000;
        const stepResults: Record<string, unknown>[] = [];
        let stalledAt: number | undefined;

        // DIVERGENCE: live sends N individual ACT commands (for per-step timeout + progress);
        // replay sends one batched ACT_SEQUENCE command (flows/replay.ts:294). A bug in either is
        // invisible from the other — cover both when changing sequence semantics.
        for (let i = 0; i < inputSteps.length; i++) {
          const step = asRecord(inputSteps[i]);
          try {
            const result = await actCommand(
              deps,
              session,
              { ref: step['ref'], action: step['action'], args: step['args'] ?? {} },
              perStepTimeout,
            );
            if (!result.ok) {
              stalledAt = i;
              stepResults.push({
                ref: step['ref'],
                action: step['action'],
                dispatched: false,
                error: result.error ?? 'step failed',
              });
              break;
            }
            const r = asRecord(result.result);
            const stepResult: Record<string, unknown> = {
              ref: r['ref'] ?? step['ref'],
              action: r['action'] ?? step['action'],
              dispatched: r['dispatched'] ?? true,
              settled: r['settled'] ?? null,
              settleReason: r['settleReason'] ?? null,
            };
            if (r['testid'] !== undefined) stepResult['testid'] = r['testid'];
            if (r['component'] !== undefined) stepResult['component'] = r['component'];
            if (r['role'] !== undefined) stepResult['role'] = r['role'];
            if (r['name'] !== undefined) stepResult['name'] = r['name'];
            if (r['source'] !== undefined) stepResult['source'] = r['source'];
            if (r['warning'] !== undefined) stepResult['warning'] = r['warning'];
            stepResults.push(stepResult);
          } catch (err: unknown) {
            stalledAt = i;
            stepResults.push({
              ref: step['ref'],
              action: step['action'],
              dispatched: null,
              timedOut: true,
              error: err instanceof Error ? err.message : 'step timed out',
            });
            break;
          }
        }

        const completed = stalledAt ?? inputSteps.length;
        if (completed > 0) {
          session.lastAct.markActed(since, undefined, undefined);
        }
        if (deps.recordings.active().length > 0 && stalledAt === undefined) {
          deps.recordings.capture(
            compileSequenceStep(args, { count: inputSteps.length, steps: stepResults }),
          );
        }
        return withControl(session, {
          since,
          dispatched: completed > 0,
          completed,
          ...(stalledAt !== undefined ? { stalled_at: stalledAt } : {}),
          steps: stepResults,
          ...healthEnvelope(session),
        });
      } finally {
        session.finishAction();
      }
    },
  },
  {
    name: ReticleTool.ACT_AND_WAIT,
    example: {
      ref: 'e42',
      action: 'click',
      until: { kind: PredicateKind.SIGNAL, name: 'todos:loaded' },
    },
    description:
      'Act on a ref, then wait for a predicate to hold — one hop for the act->observe->assert loop. ' +
      'Omit `until` to wait for the page to settle (network + DOM idle) — use this instead of a fixed sleep. ' +
      'Returns { effect } (the action result), { verdict } (predicate pass/evidence/near-miss), ' +
      '{ trace } (a digest — window_ms + summary counts of what the app did), and { since } (the act ' +
      'cursor; pass it to reticle_observe for the full per-event timeline when the counts are not enough). ' +
      'timeout_ms 0 evaluates the predicate once without waiting.',
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe(
          `Element ref (e.g. 'e42') from reticle_snapshot/reticle_query — stable until the element leaves the DOM, so no re-snapshot between actions. Give this OR \`target\`.`,
        ),
      target: z
        .record(z.unknown())
        .optional()
        .describe(
          'Find the element and act on it in ONE call, instead of a reticle_query round trip first: { testid } | { text } | { role, name } | { label }. Refuses if it matches more than one, rather than guessing.',
        ),
      action: actionTypeEnum.describe(`Action to perform: ${ACTION_TYPE_LIST}`),
      args: z
        .record(z.unknown())
        .optional()
        .describe(
          'Action-specific arguments: { value } for fill/select, { text } for type/press (the key NAME, e.g. Escape or Tab), { modifiers: ["Meta","Shift"] } for a press shortcut (Meta/Control/Shift/Alt), { toRef } for drag (the ref to drop ON — without it the drag lands nowhere), { confirmDangerous: true } for a potentially destructive control. For upload: { path } is a path on disk (absolute or relative to project root; daemon reads real bytes) or { name, content?, type? } for inline bytes.',
        ),
      predicate: PredicateSchema.optional().describe(
        'Alias for `until` (the name reticle_assert / reticle_wait_for use).',
      ),
      until: PredicateSchema.optional().describe(
        'Predicate to wait for after the action completes (same shape as reticle_assert). OMIT to wait for the page to SETTLE — network + DOM idle — the deterministic default instead of a sleep. To assert a consequence AND settle, allOf them: { kind: "allOf", predicates: [<your predicate>, { kind: "settled" }] }.',
      ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Maximum wait time in milliseconds. 0 = evaluate once without waiting. Default: 4000.',
        ),
      refuseWhenThrottled: z
        .boolean()
        .optional()
        .describe('Throw if the tab is throttled. Default: false.'),
      intent: intentArg,
      ...sessionIdShape,
    },
    outputSchema: {
      effect: z
        .unknown()
        .describe('The reticle_act result (dispatched, settled, inputMode, etc.).'),
      verdict: z.object({
        pass: z.boolean(),
        evidence: z.unknown().optional(),
        failureReason: z.string().optional(),
        observationLost: z
          .boolean()
          .optional()
          .describe(
            'The tab disconnected mid-wait, so this was never observed — the verdict is UNKNOWN, not a failure of the app.',
          ),
        // The STRUCTURED cause — observed / expected / assertion — is what the repair literature ranks
        // above the prose failureReason (structured feedback beat narrative by 10.5pp) and above a bare
        // pointer. `verdict` is `await waitForPredicate(...)`, whose EvalResult carries these on a
        // failure; without declaring them here the strict object schema silently dropped them from
        // structuredContent on the validating `full` profile — reticle_assert declares them (it spreads
        // the verdict at top level), so act_and_wait was losing the highest-value signal that assert kept.
        observed: z.string().optional(),
        expected: z.string().optional(),
        assertion: z.string().optional(),
      }),
      trace: z
        .unknown()
        .describe(
          'Reaction digest: { window_ms, summary } of what the app did (DOM/network/route/console/signal counts). The full per-event timeline is one reticle_observe { since } away.',
        ),
      summary: z
        .unknown()
        .describe(
          'Bounded causal summary: net {total,errors,headline}, consoleErrors, statePathsChanged, storageKeysChanged, stateDiffs [{path,from,to}], storageDiffs [{key,from,to}], route, signals, layoutShift, longTasks — real before→after diffs (capped), not just readings. THIS IS THE ANSWER TO "what did that click do": console, network, storage and state for this action are all here, so do NOT follow an act with reticle_console + reticle_network + reticle_state to find out — call them only to go deeper into something this block already pointed at. Every list is length-capped so the verdict can never be the field a client truncates; `elided` says which lists lost entries and how many. `stateUnwatched: true` means NO subscribable store is registered, so an empty stateDiffs means unwatched, NOT unchanged — no state conclusion is available until one is registered.',
        ),
      // Promoted out of `effect` on RED only — the file:line the failure came from, the first thing a
      // repair wants. Undeclared, it was stripped on the validating profile exactly like the structured
      // cause above was, losing the highest-value pointer on the one path (a failed verdict) that has it.
      source: z
        .string()
        .optional()
        .describe('Present only on a FAILED verdict: `file:line` of the acted element.'),
      capsule: z
        .unknown()
        .optional()
        .describe(
          'Present only on a FAILED verdict: the divergence capsule { summary, firstDivergence (declared vs observed), blastRadius (undeclared side effects) } — the fault, located, no re-exploration needed.',
        ),
      capsuleSaved: z
        .string()
        .optional()
        .describe(
          'Present only on a FAILED verdict when the fail-to-pass capsule was persisted: its id, replayable as a regression flow once the bug goes green.',
        ),
      verified: z
        .string()
        .describe(
          'THE field to gate on: "yes" | "no" | "unknown". Read this first and read `because` for the reason. "unknown" is NOT failure — it means the evidence could not decide (dirty capture, nothing asserted at a real grade, or the page never settled), which calls for a better check rather than a code change. Everything else on this result is the evidence this was derived from.',
        ),
      because: z.string().describe('One sentence naming the deciding evidence behind `verified`.'),
      contradictions: z
        .array(z.unknown())
        .optional()
        .describe(
          'Channels that DISAGREE about this action — the UI advanced while its write failed, a success signal fired over a failed request, a response changed nothing, a duplicate fired, a request never settled. OMITTED when clean. Treat any entry as a finding even when the verdict is green: a passing assertion and a contradicted channel is exactly the false green this exists to catch.',
        ),
      instrumentationGaps: z
        .array(z.unknown())
        .optional()
        .describe(
          'What the APP did not tell Reticle, and the one change that would fix it — each entry is { kind, missing, cost, fix, source?, ref? }. Reported ONLY where an absence made THIS verdict weaker (a red that cannot name a file:line, a state assertion with no registered store, a DOM change no signal announced, a route change nothing signalled); never a survey of the page, so an entry is always work worth doing now. OMITTED when the app told Reticle everything it needed. Applying `fix` makes every later verdict on this app stronger, not just this one.',
        ),
      honesty: z
        .unknown()
        .describe(
          'The verdict trust block { grade, attribution, coverage, integrity, envelope? } — a green never looks stronger than this. Gate on grade ≥ net AND integrity.clean. Fields that were not measured are OMITTED rather than reported as zero, so treat an absent `envelope` as "not sampled", never as a failure.',
        ),
      since: z
        .number()
        .describe(
          'Cursor for this act — pass to reticle_observe/reticle_assert for the full timeline.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'The session that answered, when a full-document navigation replaced the one that was acted on. Absent when the original session survived.',
        ),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
      // Short-circuits to pausedShortCircuit while paused — declare its fields (drained-once guidance).
      ...pausedOutputShape,
    },
    handler: async (deps, args) => {
      let session = deps.sessions.resolve(asString(args['sessionId']));
      const acted = session;
      const actedSessionId = session.id;
      // Live-control: refuse to drive the page (no act, no predicate eval) while paused.
      //
      // A VERDICT rides out with the refusal. This is the one tool here that promises `verified`,
      // and the bare pause payload omitted it — so an agent reading `result.verified` got undefined
      // from a call that carried no error, which is neither yes, no, nor unknown. It also broke this
      // tool's own outputSchema, where `because` is required.
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) {
        return { ...paused, verified: Verified.UNKNOWN, because: PAUSED_NO_VERDICT };
      }
      refuseIfThrottled(session, args['refuseWhenThrottled']);
      // Omitting `until` waits for the page to settle (idle) — the deterministic default vs a sleep.
      // `predicate` is what reticle_assert / reticle_wait_for call this — see alias-args.ts.
      const withUntil = aliasParam(args, 'until', ['predicate']);
      const until =
        withUntil['until'] !== undefined
          ? parsePredicate(withUntil['until'])
          : ({ kind: PredicateKind.SETTLED } as const);
      const timeout = asNumber(args['timeout_ms']) ?? DEFAULT_ASSERT_TIMEOUT_MS;
      // An intent declared here lands in the ledger BEFORE the verdict is drawn, which is what makes
      // the undeclared-change gap silent on THIS verdict rather than the next one: it reads the
      // ledger below and finds something open. The discharge comes after that read.
      const intentId = await linkInlineIntent(
        deps,
        asString(args['sessionId']),
        asString(args['intent']),
        PredicateKind.SETTLED === until.kind ? undefined : until,
      );

      // Before anything is driven: this path cannot honour a native-input request, and taking the
      // argument and ignoring it told the agent its trusted click had happened. See act-danger.
      assertNativeInputSupported(asRecord(args['args']));

      // Resolve `target` to a ref BEFORE the action window opens, so the lookup is not attributed to
      // the act and cannot be mistaken for something the action caused.
      const resolved = await resolveActTarget(session, args);
      if ('error' === resolved.kind) throw new Error(resolved.message);

      let since = session.elapsed();
      const actedSince = since;
      // The cursor + effect are marked after the act dispatches (below) — a refused act leaves none.
      // The attribution window stays open across the settle wait below, so post-dispatch async events
      // (the whole point of act_and_wait) attribute to this action. finishAction fires after the wait.
      session.beginAction(ReticleTool.ACT_AND_WAIT, asRecord(args));
      let settledOutcome: boolean | undefined;
      // The verdict, written into the action record so a LATER turn can read what this one proved.
      // A verdict that lives only in the response lives only in the agent's context window, which is
      // exactly the copy a compaction destroys — see runs/run-context.ts.
      let verdictEffect: JournalVerdictEffect | undefined;
      // Was the declared consequence ALREADY TRUE? Only asked for predicates that read live DOM
      // state — event-based ones are floored at this act's cursor and cannot be satisfied by the
      // past, so they need no pre-check and pay nothing. One extra query, on the path where a green
      // is otherwise unfalsifiable. See honesty/already-true.
      const alreadyTrue =
        until !== undefined && readsDomState(until)
          ? (await evaluatePredicate(session, until, since, false)).pass
          : false;
      try {
        // actCommand is the single interception point for upload+path rewrite.
        const actResult = await actCommand(deps, session, {
          ref: resolved.ref,
          action: args['action'],
          args: args['args'] ?? {},
        });
        if (!actResult.ok) throw new Error(actResult.error ?? 'act failed');
        captureAct(deps.recordings, args, actResult.result);
        // Dispatched — now this act owns the cursor and the effect. Marking its OWN measurement also
        // stops the spread below from inheriting an earlier reticle_act's action and mutation count.
        session.lastAct.markActed(
          since,
          asString(args['action']),
          mutatedWithin(asRecord(actResult.result)),
          asString(args['ref']),
        );

        // Honesty: floor the predicate at this act's cursor so a stale buffered event can't satisfy it.
        const predicateStarted = session.elapsed();
        let verdict =
          timeout > 0
            ? await waitForPredicate(session, until, timeout, since)
            : await evaluatePredicate(session, until, since);

        // A full-document navigation tears the SDK down mid-wait. `navigate` already waits for the
        // HELLO and returns the new id; this path used to grade `observation_lost` and leave the
        // agent holding a dead id, so the next assert failed even though the new page had loaded.
        // Follow the unique same-origin successor (the awaitArrival idea, without a known URL) and
        // evaluate there. Two live tabs at that origin is still a guess — we do not follow then.
        if (true === verdict.observationLost && timeout > 0) {
          const remaining = timeout - (session.elapsed() - predicateStarted);
          const next =
            remaining > 0 ? await awaitDocumentSuccessor(deps.sessions, session, remaining) : null;
          if (next !== null) {
            // Compute leftover on the departed session before we point `session` at the successor —
            // the new session's elapsed() starts at 0 and would refund the whole budget.
            const leftover = timeout - (session.elapsed() - predicateStarted);
            session = next;
            since = 0;
            if (leftover > 0) {
              verdict = await waitForPredicate(session, until, leftover, since);
            }
          }
        }

        // The predicate resolves the INSTANT it holds, which on an optimistically-navigating app is
        // while the write is still in flight — so the verdict was taken over a window the app had not
        // finished, and came back `unknown / unsettled` asking the CALLER to re-check. A login that
        // genuinely succeeded returned at 492ms of an 8000ms budget with every corroborating channel
        // agreeing. Spend the rest of the budget the caller already granted.
        //
        // This decides nothing: it waits for the answer instead of guessing at it. A response that
        // arrives as a FAILURE still contradicts — and now arrives INSIDE the window, where the
        // detector can see it at all — while a request still open when the budget genuinely runs out
        // reports unsettled exactly as before, an honest limit rather than an early exit. Costs
        // nothing on the common path, where no request is in flight.
        if (verdict.pass && timeout > 0) {
          const sleep = {
            sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          };
          const spent = (): number => timeout - (session.elapsed() - predicateStarted);
          await waitForInFlight(session, since, spent(), sleep);
          // Waiting for the response moved the hazard rather than removing it: the response now lands
          // inside the window BY DESIGN, and the app's re-render happens a task or two later. Close
          // the window in that gap and every channel agrees the app took a successful write and did
          // nothing — `response-ignored`, i.e. `verified:"no"` on a correct app, produced entirely by
          // where we stopped looking. A false accusation is the more damaging direction of error for
          // a verification tool: it sends someone to fix code that is not broken.
          //
          // So the response is not the end of the window; the app's REACTION to it is. Paid only in
          // the shape that would otherwise be accused — a successful mutating write with nothing
          // moved after it — and short enough that a genuinely dropped response is still reported.
          await waitForReaction(session, since, spent(), sleep);
        }

        const r = asRecord(actResult.result);
        if ('boolean' === typeof r['settled']) settledOutcome = r['settled'];
        // Where the acted element is written. Captured at act time alongside the anchor, so it is
        // available even when the action unmounted its own target.
        const actedSource = sourceOf(r['source']);
        // Remembered on the session so a LATER assertion can name a file even when its failure has no
        // element to point at — a signal that never fired, a request that was never made.
        const actedSourceLabel =
          actedSource === undefined ? undefined : `${actedSource.file}:${String(actedSource.line)}`;
        session.lastAct.markSource(actedSourceLabel);
        const windowEvents = session.eventsSince(since);
        const trace = summarizeReaction(
          buildReactionReport(windowEvents, session.elapsed() - since),
        );
        // The bounded Tier-1 causal summary — net/console/state/storage diffs the trace's counts miss.
        // ponytail: Layer B validation of this result-shape change is pending — additive + bounded.
        // On RED only, attach the Tier-2 divergence capsule (first-divergence + blast radius). Red-only,
        // so the common green path — what the loop optimizes — is unchanged; on red, diagnosis is the point.
        const links = predicateToExpectedLinks(until);
        const capsule = verdict.pass ? undefined : buildDivergenceCapsule(links, windowEvents);
        // Grade from what the verdict PROVED, not what it declared. A green anyOf holds on one branch, so
        // grading off `links` (every branch) would let a presence-only OR report grade `signal` — a false
        // green in the gate itself. `provenExpectedLinks` narrows a green to the branch that actually held;
        // on red we keep the declared links (the capsule wants the full expected surface).
        const gradedLinks = verdict.pass ? await provenExpectedLinks(session, until, since) : links;
        // Honesty: the grade this verdict actually proved + capture integrity — a green never looks
        // stronger than this block. Grade from the strongest asserted consequence; integrity from evictions.
        // Coverage: cross-origin frames / other blind spots the SDK reported during this window mean the
        // verdict didn't see everything — say so, never imply full coverage.
        const spots = blindSpotsFromState(session.blindSpots());
        const coverage = buildCoverageStatement(spots);
        const absenceBlindSpot = absenceBlindSpotNote(until, spots);
        // Nothing subscribed ⇒ the state channel is dark, and the summary must say so rather than
        // report an empty diff list that reads like a fact about the app. See CausalSummary.
        const stateUnwatched = isStateUnwatched(spots);
        // Only a spot that IMPEACHES the capture belongs in integrity — see impeachesCapture. A
        // structural boundary (virtualized rows, a cross-origin frame) is reported as coverage and
        // must not downgrade a verdict about what WAS observed.
        const impeaching = buildCoverageStatement(spots.filter((s) => impeachesCapture(s.kind)));
        // Same rule as reticle_assert: a browser-side transport gap means part of this window was
        // never seen, which is what `blindSpots` exists to say. `truncated` above covers the SERVER
        // ring buffer evicting; this covers the BROWSER queue overflowing, and they are not the same
        // loss — an act_and_wait that graded `proved` over 34 dropped events said so in a sentence
        // whose own words were "over a clean capture".
        const gapNote = transportGapNote(windowEvents);
        const impeachingNotes = [impeaching.note, gapNote].filter(
          (n): n is string => n !== undefined,
        );
        const bufferLost = session.lostSince(since);
        // Which loss, as an enum, beside the prose that describes it. Classified here because this is
        // the only place that knows the three apart: our buffer, our transport, and the page's own
        // boundaries. See `CaptureLoss`.
        const losses = [
          ...(bufferLost ? [CaptureLoss.BUFFER_LOSS] : []),
          ...(gapNote === undefined ? [] : [CaptureLoss.TRANSPORT_GAP]),
          ...(impeaching.note === undefined ? [] : [CaptureLoss.BLIND_SPOT]),
        ];
        // Named because the discharge below records the same grade the verdict reports, rather than a
        // second reading of the same evidence that could drift from it.
        const grade = gradeOf(gradedLinks);
        const honesty = buildHonestyBlock({
          grade,
          attribution: 'window',
          // Did the buffer lose scarce evidence FROM THIS WINDOW — not "did it evict anything while
          // the action ran", which was the previous rule and which is true on essentially every live
          // page. Age eviction retires everything past 60s on every push, and the churn floor is
          // sacrificed on purpose; neither costs this verdict a single event it needed. In the
          // field this made `unclean_capture` the dominant cause of `unknown`, reported for
          // evictions that happened outside the window they impeached.
          truncated: bufferLost,
          coveragePartial: Coverage.PARTIAL === coverage.coverage,
          // Settlement no longer vetoes a declared consequence that held, so the fact is carried
          // here instead of only in the verdict it used to decide. Omitted when never measured.
          ...(settledOutcome === undefined ? {} : { settled: settledOutcome }),
          ...(0 === impeachingNotes.length ? {} : { blindSpots: impeachingNotes }),
          losses,
        });
        const capsuleSaved = await saveFailedAssertCapsule({
          deps,
          verdict,
          capsule,
          links,
          args,
          actResult,
          ...(actedSource === undefined ? {} : { actedSource }),
        });
        // Pass the action: an EMPTY window then reads as "the target does not react" rather than as a
        // clean run — `settled` is satisfied by a page that did nothing, i.e. by a click that missed.
        const acted = asString(args['action']);
        // `prior` matters here for the same reason it matters on the assert path: a SCALE error
        // disagrees with a value the API stated EARLIER in the session, which an action-scoped
        // window can never contain. Without it `unit-mismatch` — the money false green, where a
        // total renders 100x off — is structurally unreachable from `act_and_wait`, which is the
        // tool the product tells agents to reach for first. Our best detector could not fire on our
        // flagship path, and nothing said so: the finding was simply never produced.
        //
        // Learning material only. Attribution is unchanged — findings still come exclusively from
        // `windowEvents`, exactly as on the assert path.
        const prior =
          since > 0 ? (await session.queryEvents({ since: 0 })).filter((e) => e.t < since) : [];
        //
        // `actionSince` is the window's own floor here, which is the tightest attribution there is —
        // and it is what lets `duplicate-request` claim "one user action was performed" and mean it.
        // What the caller DECLARED before acting, handed to the detector that would otherwise judge
        // the window as if nobody had said what they expected. See events/declared.ts.
        const declared = declaredExpectations(until);
        const contradictions = findContradictions(windowEvents, {
          action: acted,
          prior,
          actionSince: since,
          expectedFailures: declared.netFailures,
          // A consequence that was already true before the action proves nothing about it, so it is
          // not evidence the destination rendered either — `alreadyTrue` decides that, once.
          renderProved: verdict.pass && !alreadyTrue && declared.rendersContent,
          ...session.lastAct.effect(),
          currentDocumentId: session.currentDocumentId,
          currentEditEpoch: session.currentEditEpoch,
        });
        // The single field an agent reads. Everything below it is the evidence it was derived from;
        // this is the only one that has to be interpreted, and now it interprets itself.
        const outcomePending = hasAcceptedWrite(windowEvents);
        const outcomeUnread = unreadWriteLabels(windowEvents);
        const decision = decideVerified({
          pass: verdict.pass,
          // The caller NAMED the consequence rather than defaulting to "wait for idle". A
          // declaration made before the action is what this tool sells, and idle-settlement was
          // overriding it — see `declaredConsequence`. An explicit `{ kind: "settled" }` is not a
          // declaration about the app's behaviour, it IS the idle wait, so it does not count.
          declaredConsequence: until.kind !== PredicateKind.SETTLED,
          // A body-independent declaration that held is a channel the unread payload does not own.
          // Omit when false: a net-only `until` must still hit `outcome_unread`.
          ...(declaresBodyIndependentChannel(until) ? { independentOfBody: true } : {}),
          ...(alreadyTrue ? { alreadyTrue } : {}),
          // An assertion nobody could evaluate must not be reported as one the app failed.
          ...(verdict.inconclusive === undefined ? {} : { inconclusive: verdict.inconclusive }),
          // Nor must one nobody could OBSERVE. This is the act path, so it is the one that produced
          // the measured false red: a reload mid-wait, graded assertion_failed at the clicked
          // component's own file and line.
          ...(true === verdict.observationLost ? { observationLost: true } : {}),
          ...(absenceBlindSpot === undefined ? {} : { absenceBlindSpot }),
          honesty,
          contradictions,
          ...(outcomePending ? { outcomePending } : {}),
          ...(outcomeUnread.length > 0 ? { outcomeUnread } : {}),
          // `settled` is genuinely optional: a wait that declared no predicate never measured it, and
          // passing `false` there would report "never settled" about something never asked to settle.
          ...(settledOutcome === undefined ? {} : { settled: settledOutcome }),
          // What the wait was for and what was still outstanding when it ended. Read only by the
          // UNSETTLED clauses; supplied always because both of them are reachable from here and the
          // window is already in hand.
          unsettled: {
            waitedFor: describeWaitTarget(until),
            stillInFlight: inFlightRequestLabels(windowEvents),
            // The retry loop that leaves nothing outstanding — see repeatedRequestLabels.
            repeated: repeatedRequestLabels(windowEvents),
          },
        });
        // Computed once: the verdict block reports it, and the instrumentation gaps are a second
        // reading of the same evidence rather than a new observation.
        const actionSummary = causalSummary(windowEvents, { stateUnwatched });
        // Asked of every verdict drawn after an observed edit, not once per edit — see
        // isChangeUndeclared for why repeating it is disclosure rather than nagging.
        // Read ONCE and used twice: `changeUndeclared` asks whether the ledger is empty, and the
        // undischarged-intent gap asks how much it still holds. Two reads would be two chances for
        // them to disagree about the same file.
        const openIntents = await openSessionIntents(deps, asString(args['sessionId']));
        const changeUndeclared = await isChangeUndeclared(session.currentEditEpoch, () =>
          Promise.resolve(openIntents),
        );
        const gaps = gapsForAction({
          pass: verdict.pass,
          proved: decision.verifiedReason === VerifiedReason.PROVED,
          changeUndeclared,
          source: actedSourceLabel,
          ref: asString(args['ref']),
          stateAsked: declaresState(until),
          stateUnwatched,
          // What the app DECLARED, so an under-instrumented one is told without having to be asked.
          hasCapabilities: session.hasCapabilities,
          // What the run still owes. A green that leaves this above zero is not the same as done.
          // MINUS the one this verdict is about to discharge.
          //
          // The discharge happens below, after the gaps are built, so a straight `openIntents.length`
          // counts the intent this very call proves. Measured live on the first drive: an inline
          // intent was declared, asserted and PROVED by the same verdict, and the result still said
          // "1 declared intent(s) are still unproved" while the ledger recorded it `proved`. A gap
          // that fires on the one path doing everything right is noise, and noise is what gets
          // filtered out — taking the honest gaps with it.
          openIntentCount: openIntents.filter(
            (i) =>
              !(intentId !== undefined && Verified.YES === decision.verified && i.id === intentId),
          ).length,
          domMutated: (session.lastAct.effect().mutatedWithin ?? 0) > 0,
          signalsFired: actionSummary.signals.length,
          routeChanged: actionSummary.route !== undefined,
          routeSignalFired: actionSummary.signals.some((name) => name.startsWith('route')),
        });
        // The verdict IS the proof attempt, so a green one discharges the intent it was drawn for.
        // Only a green: a red proved nothing, and `dischargeIntent` refuses an unbound intent anyway,
        // so a bare settle leaves it open rather than collecting a proof nothing earned. The id is
        // checked here rather than only inside the helper so a caller that declared no intent touches
        // nothing at all, not even the clock.
        if (intentId !== undefined && Verified.YES === decision.verified) {
          await dischargeInlineIntent(deps, asString(args['sessionId']), intentId, {
            verdictId: inlineVerdictId(ReticleTool.ACT_AND_WAIT, deps.now()),
            grade,
            at: deps.now(),
          });
        }
        verdictEffect = {
          claim: describeWaitTarget(until),
          verified: decision.verified,
          ...(actedSourceLabel === undefined ? {} : { source: actedSourceLabel }),
        };
        // Recorded on the session, so a later "am I done?" can answer with what is STILL missing
        // rather than with everything that was ever missing. An empty list closes a gap, which is
        // why it is noted rather than skipped.
        noteSessionGaps(session, gaps);
        return withControl(session, {
          ...decision,
          effect: leanActResult(actResult.result),
          verdict,
          // Promoted out of `effect` on red only. On green nobody needs it and it is noise; on red it
          // is the first thing the agent wants, and burying a file:line inside the effect block is
          // most of the way to not reporting it at all.
          ...(verdict.pass || actedSourceLabel === undefined ? {} : { source: actedSourceLabel }),
          trace,
          ...(capsuleSaved === undefined ? {} : { capsuleSaved }),
          // The window cannot say whether anything was WATCHING state — that is a level fact the
          // session holds. Without it an empty `stateDiffs` reads as "the app changed nothing".
          summary: actionSummary,
          // What the APP did not tell Reticle, and the one change that would fix it. Reported only
          // where an absence made this very verdict weaker — never as a survey of the page.
          ...(gaps.length > 0 ? { instrumentationGaps: gaps } : {}),
          // Cross-channel disagreement, reported WITH the action that caused it.
          //
          // This is the one finding here a human structurally cannot make — they watch one channel,
          // the screen, so a UI that advanced while its write failed looks like success to them and
          // always will. It ran only inside reticle_observe, which means it was found only when the
          // agent already suspected something and thought to go looking. That inverts the value: the
          // whole point is catching what NOBODY suspected. It now travels with the action, so an
          // agent cannot miss it by not asking. Omitted entirely when clean, so a healthy action
          // pays nothing.
          ...(contradictions.length > 0 ? { contradictions } : {}),
          honesty,
          ...(capsule === undefined ? {} : { capsule }),
          since,
          ...(session.id === actedSessionId ? {} : { sessionId: session.id }),
          ...healthEnvelope(session),
        });
      } finally {
        acted.finishAction(
          verdictEffect,
          settledOutcome,
          true === settledOutcome ? acted.elapsed() - actedSince : undefined,
        );
      }
    },
  },
];

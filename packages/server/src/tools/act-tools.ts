/**
 * Action tools — reticle_act, reticle_act_sequence, reticle_act_and_wait — plus the native-input machinery
 * (asBox / tryRealInput). Split out of tools.ts to keep that file under the line cap; assembled back
 * into the tool list there via ...ACT_TOOLS.
 */
import { z } from 'zod';
import { compileActStep, compileSequenceStep } from '../flows/replay.js';
import {
  ActionType,
  ActionWarning,
  DANGEROUS_ACTION_CONFIRM_ARG,
  InputMode,
  InputModeReason,
  ReticleCommand,
  isDangerousActionText,
} from '@reticle/protocol';
import type { Session } from '../session/session.js';
import type { ElementBox, RealInputArgs } from '../input/real-input.js';
import { isPointerAction } from '../input/real-input.js';
import { leanActResult } from './act-view.js';
import { ReticleTool } from './tool-names.js';
import { buildReactionReport, summarizeReaction } from '../events/reaction.js';
import { evaluatePredicate, waitForPredicate, PredicateSchema } from '../events/predicate.js';
import { healthEnvelope, refuseIfThrottled } from '../session/session-health.js';
import { pausedShortCircuit, withControl } from '../session/control-envelope.js';
import { asString, asNumber, asRecord } from './tools-helpers.js';
import { type ToolDef, type ToolDeps, sessionIdShape, commandOrThrow } from './tool-kit.js';

/** Narrow an INSPECT result's `box` into a positive-area ElementBox (else undefined). */
function asBox(value: unknown): ElementBox | undefined {
  const b = asRecord(asRecord(value)['box']);
  const x = asNumber(b['x']);
  const y = asNumber(b['y']);
  const w = asNumber(b['width']);
  const h = asNumber(b['height']);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  if (w <= 0 || h <= 0) return undefined; // zero-area (display:none) ⇒ native click would miss
  return { x, y, width: w, height: h };
}

/** Outcome of a real-input attempt — real success (result set) or synthetic with a reason. */
interface RealActResult {
  /** Defined only on a successful native action; `undefined` means the synthetic path runs. */
  result: unknown;
  settled: boolean;
  /** Set when a provider was available but threw — surfaces the fallback to the agent. */
  fellBack?: boolean;
  /** Why we went synthetic despite a configured provider (field bug #2: never a silent fallback). */
  reason?: InputModeReason;
}

/** Synthetic outcome with a diagnostic reason (provider configured but native input skipped). */
function synthetic(reason?: InputModeReason): RealActResult {
  return reason === undefined
    ? { result: undefined, settled: false }
    : { result: undefined, settled: false, reason };
}

/**
 * Attempt to drive a pointer action via native input. Returns a synthetic outcome (with a
 * `reason` when a provider is configured) whenever the synthetic path should run — no matching
 * page, unresolvable box, declined, etc. A throw inside the provider becomes a synthetic fallback
 * flagged with `fellBack`. `result` is defined only on a real success.
 */
async function tryRealInput(
  deps: ToolDeps,
  session: Session,
  ref: string,
  action: string,
  args: Record<string, unknown>,
): Promise<RealActResult> {
  const provider = deps.realInput;
  if (provider === undefined) return synthetic(); // real input not configured — no diagnostic
  if (!isPointerAction(action)) return synthetic(InputModeReason.NOT_POINTER); // fill/type stay synthetic

  const inner = asRecord(args['args']);
  // "Don't click, run the code": a click/dblclick runs the occlusion-honest SYNTHETIC path by default
  // even with a provider configured — no coordinate gesture to be intercepted by the HUD or missed
  // off-screen. Opt into a trusted native click with args.native:true (file pickers, clipboard,
  // isTrusted-gated handlers). hover/drag genuinely need native pointer state, so they stay real.
  if ((action === ActionType.CLICK || action === ActionType.DBLCLICK) && inner['native'] !== true) {
    return synthetic(InputModeReason.SYNTHETIC_CLICK_PREFERRED);
  }

  if (!(await provider.isAvailableFor(session.url)))
    return synthetic(InputModeReason.PAGE_NOT_CORRELATED);

  const inspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, { ref });
  const confirmed = inner[DANGEROUS_ACTION_CONFIRM_ARG] === true;
  const dangerousDescriptorText = (value: unknown): string => {
    const descriptor = asRecord(value);
    return [
      asString(descriptor['name']) ?? '',
      asString(descriptor['text']) ?? '',
      asString(descriptor['value']) ?? '',
      asString(descriptor['href']) ?? '',
      asString(descriptor['formAction']) ?? '',
      asString(descriptor['formText']) ?? '',
    ].join(' ');
  };
  if (
    (action === ActionType.CLICK || action === ActionType.DBLCLICK) &&
    !confirmed &&
    isDangerousActionText(dangerousDescriptorText(inspected))
  ) {
    throw new Error(
      `potentially destructive native action blocked; retry with args.${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
    );
  }
  const box = asBox(inspected);
  if (box === undefined) return synthetic(InputModeReason.ELEMENT_NOT_LOCATABLE);

  let toBox: ElementBox | undefined;
  if (action === ActionType.DRAG) {
    const toRef = asString(inner['toRef']);
    if (toRef === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
    const targetInspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, {
      ref: toRef,
    });
    if (
      !confirmed &&
      isDangerousActionText(
        `${dangerousDescriptorText(inspected)} ${dangerousDescriptorText(targetInspected)}`,
      )
    ) {
      throw new Error(
        `potentially destructive native action blocked; retry with args.${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
      );
    }
    toBox = asBox(targetInspected);
    if (toBox === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
  }

  const performArgs: RealInputArgs = {};
  const value = asString(inner['value']);
  if (value !== undefined) performArgs.value = value;
  const text = asString(inner['text']);
  if (text !== undefined) performArgs.text = text;
  if (toBox !== undefined) performArgs.toBox = toBox;

  try {
    const performed = await provider.perform(session.url, action, box, performArgs);
    if (!performed.performed) return synthetic(InputModeReason.PROVIDER_DECLINED);
    return { result: { performed: true, center: performed.center, action }, settled: true };
  } catch {
    return {
      result: undefined,
      settled: false,
      fellBack: true,
      reason: InputModeReason.PROVIDER_ERROR,
    };
  }
}

export const ACT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.ACT,
    description:
      'Execute one action against a ref: click|dblclick|hover|focus|fill|type|clear|select|check|uncheck|submit|press|scrollIntoView. Returns immediately with a `since` cursor — observe the reaction with reticle_observe. Carries effect:{dispatched,targetMatched,visible,enabled,focusMoved,valueChanged,domMutatedWithin,occluded,occludedBy,scrolledIntoView} to tell "action missed" from "app didn\'t react"; dispatched=landed, settled=a real frame flushed, and a settle timeout never fails the tool. Fields at their uninformative default are OMITTED so a clean action collapses to its consequence: an absent dispatched/targetMatched/visible/enabled means true, an absent occluded/scrolledIntoView/valueChanged/defaultPrevented means false, an absent focusMoved/occludedBy means null. occluded=true means the click point is covered by another element (a real user could not click it) — synthetic dispatch still delivered the event; scrolledIntoView=true means an off-viewport target was scrolled in first. inputMode is "real" (native CDP, no synthetic effect block) or "synthetic"; clicks default to the occlusion-honest synthetic path even when CDP is configured — pass args.native:true to force a trusted native click (file pickers, clipboard). inputModeReason explains any real→synthetic choice so it is never silent. Full model (real-input, throttled tabs, `reticle drive`): docs/usage.md §18.',
    inputSchema: {
      ref: z.string().describe("Element ref from reticle_snapshot or reticle_query (e.g. 'e42')."),
      action: z
        .string()
        .describe(
          'Action to perform: click | dblclick | hover | focus | fill | type | clear | select | check | uncheck | submit | press | scrollIntoView',
        ),
      args: z
        .record(z.unknown())
        .optional()
        .describe(
          'Action-specific arguments: { value } for fill/select, { text } for type/press, { native: true } to force a trusted native click, { confirmDangerous: true } to allow a potentially destructive control.',
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
      result: z.unknown().optional(),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // Live-control: refuse to drive the page while the human has paused us (before any work).
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      refuseIfThrottled(session, args['refuseWhenThrottled']);
      const since = session.elapsed();
      session.markActCursor(since); // honesty: wait_for/assert default their floor to this cursor
      const ref = asString(args['ref']) ?? '';
      const action = asString(args['action']) ?? '';

      // drive native pointer input when a provider is available; otherwise fall back.
      const real = await tryRealInput(deps, session, ref, action, args);
      if (real.result !== undefined) {
        if (deps.recordings.active().length > 0) {
          deps.recordings.capture(compileActStep(args, real.result));
        }
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

      const result = await session.command(ReticleCommand.ACT, {
        ref: args['ref'],
        action: args['action'],
        args: args['args'] ?? {},
      });
      if (!result.ok) throw new Error(result.error ?? 'act failed');
      if (deps.recordings.active().length > 0) {
        deps.recordings.capture(compileActStep(args, result.result));
      }
      // lift dispatch/settle status to the envelope (a settle timeout is NOT a failure).
      const r = asRecord(result.result);
      return withControl(session, {
        since,
        inputMode: InputMode.SYNTHETIC,
        // #2: never a silent real→synthetic fallback — say WHY (unless real input isn't configured).
        ...(real.reason !== undefined ? { inputModeReason: real.reason } : {}),
        dispatched: r['dispatched'] ?? true,
        settled: r['settled'] ?? null,
        settleReason: r['settleReason'] ?? null,
        result: leanActResult(result.result),
        ...(real.fellBack === true ? { warning: ActionWarning.REAL_INPUT_FELL_BACK } : {}),
        ...healthEnvelope(session),
      });
    },
  },
  {
    name: ReticleTool.ACT_SEQUENCE,
    description:
      'Run multiple actions in order (fill -> fill -> submit) in one round-trip. Returns per-step effects[] (see reticle_act).',
    inputSchema: {
      steps: z
        .array(z.record(z.unknown()))
        .describe(
          'Ordered list of { ref, action, args? } objects. Each step is equivalent to one reticle_act call; put confirmDangerous:true in a destructive step args object.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      since: z.number(),
      dispatched: z.boolean(),
      result: z.unknown().optional(),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // Live-control: refuse to drive the page while the human has paused us (before any work).
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      const since = session.elapsed();
      session.markActCursor(since); // honesty: a later wait_for/assert floors at this cursor
      const result = await session.command(ReticleCommand.ACT_SEQUENCE, { steps: args['steps'] });
      if (!result.ok) throw new Error(result.error ?? 'act_sequence failed');
      if (deps.recordings.active().length > 0) {
        deps.recordings.capture(compileSequenceStep(args, result.result));
      }
      const r = asRecord(result.result); // per-step settle status lives in result.steps[]
      return withControl(session, {
        since,
        dispatched: r['count'] !== undefined,
        result: leanActResult(result.result),
        ...healthEnvelope(session),
      });
    },
  },
  {
    name: ReticleTool.ACT_AND_WAIT,
    description:
      'Act on a ref, then wait for a predicate to hold — one hop for the act->observe->assert loop. ' +
      'Omit `until` to wait for the page to settle (network + DOM idle) — use this instead of a fixed sleep. ' +
      'Returns { effect } (the action result), { verdict } (predicate pass/evidence/near-miss), ' +
      '{ trace } (a digest — window_ms + summary counts of what the app did), and { since } (the act ' +
      'cursor; pass it to reticle_observe for the full per-event timeline when the counts are not enough). ' +
      'timeout_ms 0 evaluates the predicate once without waiting.',
    inputSchema: {
      ref: z.string().describe('Element ref from reticle_snapshot or reticle_query.'),
      action: z
        .string()
        .describe(
          'Action to perform: click | dblclick | hover | focus | fill | type | clear | select | check | uncheck | submit | press | scrollIntoView',
        ),
      args: z
        .record(z.unknown())
        .optional()
        .describe(
          'Action-specific arguments: { value } for fill/select, { text } for type/press, { confirmDangerous: true } for a potentially destructive control.',
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
      }),
      trace: z
        .unknown()
        .describe(
          'Reaction digest: { window_ms, summary } of what the app did (DOM/network/route/console/signal counts). The full per-event timeline is one reticle_observe { since } away.',
        ),
      since: z
        .number()
        .describe(
          'Cursor for this act — pass to reticle_observe/reticle_assert for the full timeline.',
        ),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // Live-control: refuse to drive the page (no act, no predicate eval) while paused.
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      refuseIfThrottled(session, args['refuseWhenThrottled']);
      // Omitting `until` waits for the page to settle (idle) — the deterministic default vs a sleep.
      const until =
        args['until'] !== undefined
          ? PredicateSchema.parse(args['until'])
          : ({ kind: 'settled' } as const);
      const timeout = asNumber(args['timeout_ms']) ?? 4000;

      const since = session.elapsed();
      session.markActCursor(since);
      const actResult = await session.command(ReticleCommand.ACT, {
        ref: args['ref'],
        action: args['action'],
        args: args['args'] ?? {},
      });
      if (!actResult.ok) throw new Error(actResult.error ?? 'act failed');

      // Honesty: floor the predicate at this act's cursor so a stale buffered event can't satisfy it.
      const verdict =
        timeout > 0
          ? await waitForPredicate(session, until, timeout, since)
          : await evaluatePredicate(session, until, since);

      const trace = summarizeReaction(
        buildReactionReport(session.eventsSince(since), session.elapsed() - since),
      );
      return withControl(session, {
        effect: leanActResult(actResult.result),
        verdict,
        trace,
        since,
        ...healthEnvelope(session),
      });
    },
  },
];

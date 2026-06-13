import { z } from 'zod';
import {
  ActionType,
  ActionWarning,
  EventType,
  InputMode,
  InputModeReason,
  IrisCommand,
  SnapshotMode,
} from '@syrin/iris-protocol';
import type { Session, SessionManager } from '../session/session.js';
import type { ElementBox, RealInputArgs, RealInputProvider } from '../input/real-input.js';
import { isPointerAction } from '../input/real-input.js';
import { IrisTool } from './tool-names.js';
import { buildReactionReport } from '../events/reaction.js';
import { evaluatePredicate, waitForPredicate, PredicateSchema } from '../events/predicate.js';
import { type BaselineStore, normalizeLines, diffLines } from '../project/baselines.js';
import { REPLAY_PROGRAM_VERSION } from '@syrin/iris-protocol';
import type { RecordingStore, CompiledProgram } from '../flows/recordings.js';
import { compileActStep, compileSequenceStep, replayProgram } from '../flows/replay.js';
import {
  matchNet,
  matchConsole,
  isConsoleEvent,
  netEmptyHint,
  consoleEmptyHint,
} from '../events/event-filters.js';
import { healthEnvelope, refuseIfThrottled } from '../session/session-health.js';
import { applyEventBudget, costHint } from '../session/output-budget.js';
import { selectPath, capDepth } from '../session/state-select.js';
import { asString, asNumber, asRecord, parseInteractive } from './tools-helpers.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { FlowStore } from '../flows/flows.js';
import type { ProjectStore } from '../project/project-store.js';
import { CONTRACT_TOOLS } from './contract-tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import { FLOW_TOOLS } from '../flows/flow-tools.js';
import { PROJECT_TOOLS } from '../project/project-tools.js';
import { VISUAL_TOOLS } from '../visual/visual-tools.js';
import { CRAWL_TOOLS } from '../crawl/crawl-tools.js';
import { SCROLL_TOOLS } from '../input/scroll-tools.js';
import { SESSION_TOOLS } from '../session/session-tools.js';
import { ANNOTATE_TOOLS } from '../flows/annotate-tools.js';
import { LIVE_CONTROL_TOOLS } from '../session/live-control-tools.js';
import { pausedShortCircuit, withControl } from '../session/control-envelope.js';
import type { AnnotationStore } from '../flows/annotation-store.js';

export interface ToolDeps {
  sessions: SessionManager;
  baselines: BaselineStore;
  recordings: RecordingStore;
  /** on-disk anchored-flow store (.iris/flows/). */
  flows: FlowStore;
  /** structured annotations accumulating for the live recording. */
  annotations: AnnotationStore;
  /** cross-run outcome memory (.iris/project.json). */
  project: ProjectStore;
  /** optional native-input provider. undefined ⇒ everything stays synthetic. */
  realInput?: RealInputProvider;
  /** injected filesystem seam (tests pass a fake/temp-dir adapter). */
  fs: FileSystemPort;
  /** absolute .iris path (index.ts computes cwd()/.iris). */
  irisRoot: string;
  /** injected clock for the contract's generatedAt stamp. */
  now: () => number;
}

interface SnapshotResult {
  tree?: string;
  status?: { route?: string };
}

async function snapshotTree(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<{ lines: string[]; route: string }> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(IrisCommand.SNAPSHOT, { mode: SnapshotMode.FULL });
  if (!result.ok) throw new Error(result.error ?? 'snapshot failed');
  const snap = (result.result ?? {}) as SnapshotResult;
  return { lines: normalizeLines(snap.tree ?? ''), route: snap.status?.route ?? '' };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /**
   * JSON Schema-compatible output schema for this tool. When present, the MCP server advertises it
   * in the tools/list response so schema-aware clients (like @syrin/cli) can validate outputs and
   * compose tool calls safely. Also drives TOON encoding for snapshot/query results.
   */
  outputSchema?: z.ZodRawShape;
  handler: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'Active session ID from iris_sessions. Omit when only one browser session is open — Iris resolves it automatically.',
    ),
};

/** Unwrap a browser command result or throw its error so the agent sees a clean failure. */
async function commandOrThrow(
  deps: ToolDeps,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(name, args);
  if (!result.ok) throw new Error(result.error ?? `command '${name}' failed`);
  return result.result;
}

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

  const box = asBox(await commandOrThrow(deps, session.id, IrisCommand.INSPECT, { ref }));
  if (box === undefined) return synthetic(InputModeReason.ELEMENT_NOT_LOCATABLE);

  let toBox: ElementBox | undefined;
  if (action === ActionType.DRAG) {
    const toRef = asString(inner['toRef']);
    if (toRef === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
    toBox = asBox(await commandOrThrow(deps, session.id, IrisCommand.INSPECT, { ref: toRef }));
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

export const TOOLS: ToolDef[] = [
  {
    name: IrisTool.SESSIONS,
    description:
      'List connected browser sessions (tab url/title, sessionId, last-seen, health: hidden/focused/throttled, and `realInputAvailable` — true when native CDP/launched real input is driving this tab), plus a `recommendation` pointing to `iris drive` when a tab is hidden/throttled and may be un-scriptable from here.',
    inputSchema: {},
    outputSchema: {
      sessions: z
        .array(
          z.object({
            sessionId: z.string(),
            url: z.string(),
            title: z.string().optional(),
            lastSeenMs: z.number(),
            throttled: z.boolean(),
            focused: z.boolean(),
            hidden: z.boolean(),
            realInputAvailable: z.boolean().optional(),
            stale: z.boolean().optional(),
            recommendation: z.string().optional(),
          }),
        )
        .describe('Connected browser sessions with health state.'),
    },
    handler: async (deps) => {
      const provider = deps.realInput;
      const sessions = await Promise.all(
        deps.sessions.list().map(async (s) => ({
          ...s,
          realInputAvailable: provider !== undefined ? await provider.isAvailableFor(s.url) : false,
        })),
      );
      return { sessions };
    },
  },
  {
    name: IrisTool.SNAPSHOT,
    description:
      'Semantic accessibility snapshot of the page or a subtree. mode: full|interactive|status. Use to see what is on screen right now.',
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          'CSS selector or element ref to restrict the snapshot to a subtree. Omit to snapshot the whole page.',
        ),
      mode: z
        .nativeEnum(SnapshotMode)
        .optional()
        .describe(
          'full = all elements; interactive = only clickable/focusable elements; status = only route + title. Default: full.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      tree: z
        .string()
        .optional()
        .describe('Indented ARIA tree of every element on the page (or the scoped subtree).'),
      status: z.object({ route: z.string(), title: z.string().optional() }).optional(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.SNAPSHOT, {
        scope: args['scope'],
        mode: args['mode'] ?? SnapshotMode.FULL,
      }),
  },
  {
    name: IrisTool.QUERY,
    description:
      'Find elements by Testing-Library semantics. Pass `by` (role|text|label|placeholder|testid|alt) and `value` (the query string). Returns matching refs + descriptors + visibility. On zero matches, also returns hint:{ route, presentTestids[], knownEmptyState } so you can distinguish an empty state from a missing element WITHOUT taking a snapshot.',
    inputSchema: {
      by: z.string().describe('Query strategy: role | text | label | placeholder | testid | alt'),
      value: z
        .string()
        .describe(
          'Query value for the selected strategy (e.g. by=role value=button, or by=testid value=submit-btn).',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Accessible name filter — narrows results when `by` is role and the page has many elements of that role.',
        ),
      scope: z
        .string()
        .optional()
        .describe('CSS selector or element ref to restrict the search to a subtree.'),
      ...sessionIdShape,
    },
    outputSchema: {
      elements: z.array(
        z.object({
          ref: z.string(),
          role: z.string(),
          name: z.string(),
          value: z.string().optional(),
          states: z.array(z.string()),
          visible: z.boolean(),
        }),
      ),
      hint: z
        .object({
          route: z.string(),
          presentTestids: z.array(z.string()),
          knownEmptyState: z.boolean(),
        })
        .optional()
        .describe(
          'Present only on zero matches — tells you what IS on the page so you can diagnose the miss.',
        ),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.QUERY, {
        by: args['by'],
        value: args['value'],
        name: args['name'],
        scope: args['scope'],
      }),
  },
  {
    name: IrisTool.INSPECT,
    description:
      'Deep info on one element by ref: full a11y props, visibility, box, and (with @syrin/iris-react) component stack + source file.',
    inputSchema: {
      ref: z.string().describe("Element ref from iris_snapshot or iris_query (e.g. 'e42')."),
      ...sessionIdShape,
    },
    outputSchema: {
      ref: z.string(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      states: z.array(z.string()),
      visible: z.boolean(),
      box: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
      component: z.object({ name: z.string(), sourceFile: z.string().optional() }).optional(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.INSPECT, {
        ref: args['ref'],
      }),
  },
  {
    name: IrisTool.ACT,
    description:
      'Execute one action against a ref: click|dblclick|hover|focus|fill|type|clear|select|check|uncheck|submit|press|scrollIntoView. Returns immediately with a `since` cursor — observe the reaction with iris_observe. Carries effect:{dispatched,targetMatched,visible,enabled,focusMoved,valueChanged,domMutatedWithin,occluded,occludedBy,scrolledIntoView} to tell "action missed" from "app didn\'t react"; dispatched=landed, settled=a real frame flushed, and a settle timeout never fails the tool. occluded=true means the click point is covered by another element (a real user could not click it) — synthetic dispatch still delivered the event; scrolledIntoView=true means an off-viewport target was scrolled in first. inputMode is "real" (native CDP, no synthetic effect block) or "synthetic"; clicks default to the occlusion-honest synthetic path even when CDP is configured — pass args.native:true to force a trusted native click (file pickers, clipboard). inputModeReason explains any real→synthetic choice so it is never silent. Full model (real-input, throttled tabs, `iris drive`): docs/usage.md §18.',
    inputSchema: {
      ref: z.string().describe("Element ref from iris_snapshot or iris_query (e.g. 'e42')."),
      action: z
        .string()
        .describe(
          'Action to perform: click | dblclick | hover | focus | fill | type | clear | select | check | uncheck | submit | press | scrollIntoView',
        ),
      args: z
        .record(z.unknown())
        .optional()
        .describe(
          'Action-specific arguments: { value } for fill/select, { text } for type/press, { native: true } to force a trusted native click.',
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
          'Cursor — pass to iris_observe/iris_wait_for/iris_assert to scope reaction queries to this act.',
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
          result: real.result,
          ...healthEnvelope(session),
        });
      }

      const result = await session.command(IrisCommand.ACT, {
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
        result: result.result,
        ...(real.fellBack === true ? { warning: ActionWarning.REAL_INPUT_FELL_BACK } : {}),
        ...healthEnvelope(session),
      });
    },
  },
  {
    name: IrisTool.ACT_SEQUENCE,
    description:
      'Run multiple actions in order (fill -> fill -> submit) in one round-trip. Returns per-step effects[] (see iris_act).',
    inputSchema: {
      steps: z
        .array(z.record(z.unknown()))
        .describe(
          'Ordered list of { ref, action, args? } objects. Each step is equivalent to one iris_act call.',
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
      const result = await session.command(IrisCommand.ACT_SEQUENCE, { steps: args['steps'] });
      if (!result.ok) throw new Error(result.error ?? 'act_sequence failed');
      if (deps.recordings.active().length > 0) {
        deps.recordings.capture(compileSequenceStep(args, result.result));
      }
      const r = asRecord(result.result); // per-step settle status lives in result.steps[]
      return withControl(session, {
        since,
        dispatched: r['count'] !== undefined,
        result: result.result,
        ...healthEnvelope(session),
      });
    },
  },
  {
    name: IrisTool.ACT_AND_WAIT,
    description:
      'Act on a ref, then wait for a predicate to hold — one hop for the act->observe->assert loop. ' +
      'Returns { effect } (the action result), { verdict } (predicate pass/evidence/near-miss), ' +
      'and { trace } (the reaction report of everything the app did after the action). ' +
      'timeout_ms 0 evaluates the predicate once without waiting.',
    inputSchema: {
      ref: z.string().describe('Element ref from iris_snapshot or iris_query.'),
      action: z
        .string()
        .describe(
          'Action to perform: click | dblclick | hover | focus | fill | type | clear | select | check | uncheck | submit | press | scrollIntoView',
        ),
      args: z
        .record(z.unknown())
        .optional()
        .describe('Action-specific arguments: { value } for fill/select, { text } for type/press.'),
      until: PredicateSchema.describe(
        'Predicate to wait for after the action completes. Same shape accepted by iris_assert.',
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
      effect: z.unknown().describe('The iris_act result (dispatched, settled, inputMode, etc.).'),
      verdict: z.object({
        pass: z.boolean(),
        evidence: z.unknown().optional(),
        failureReason: z.string().optional(),
      }),
      trace: z.unknown().describe('Reaction report (same shape as iris_observe summary).'),
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
      const until = PredicateSchema.parse(args['until']);
      const timeout = asNumber(args['timeout_ms']) ?? 4000;

      const since = session.elapsed();
      session.markActCursor(since);
      const actResult = await session.command(IrisCommand.ACT, {
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

      const trace = buildReactionReport(session.eventsSince(since), session.elapsed() - since);
      return withControl(session, {
        effect: actResult.result,
        verdict,
        trace,
        ...healthEnvelope(session),
      });
    },
  },
  {
    name: IrisTool.OBSERVE,
    description:
      'Return the timeline of everything the app did in a window (DOM/network/route/console/animation/signal), with a summary. Use after an action. Pass `max_events` to cap the timeline to the most recent N (older events are dropped and counted in cost.droppedOldest). Every result carries a `cost:{events,bytes}` hint so you can self-budget your next call.',
    inputSchema: {
      window_ms: z
        .number()
        .optional()
        .describe('Time window to look back. Default: 2000ms. Ignored when `since` is provided.'),
      since: z
        .number()
        .optional()
        .describe(
          'Cursor from a prior iris_act or iris_observe call. Scopes the event window to exactly that span.',
        ),
      filters: z
        .array(z.string())
        .optional()
        .describe(
          'Event type allowlist: dom | net | route | console | animation | signal. Omit to return all types.',
        ),
      max_events: z
        .number()
        .optional()
        .describe(
          'Cap the timeline to the most recent N events. Older events are counted in cost.droppedOldest.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      events: z.array(z.unknown()),
      summary: z.object({
        total: z.number(),
        network: z.number(),
        domAdded: z.number(),
        domRemoved: z.number(),
        domChanged: z.number(),
        routeChanges: z.number(),
        consoleErrors: z.number(),
        animations: z.number(),
        signals: z.number(),
      }),
      cost: z.object({
        events: z.number(),
        bytes: z.number(),
        droppedOldest: z.number().optional(),
      }),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']);
      const windowMs = asNumber(args['window_ms']) ?? 2000;
      const events =
        since !== undefined ? session.eventsSince(since) : session.eventsInWindow(windowMs);
      const filters = Array.isArray(args['filters']) ? (args['filters'] as string[]) : undefined;
      const filtered =
        filters === undefined ? events : events.filter((e) => filters.includes(e.type));
      // Output budget: cap to the most recent N (no silent caps — droppedOldest is surfaced in cost).
      const { events: budgeted, droppedOldest } = applyEventBudget(
        filtered,
        asNumber(args['max_events']),
      );
      const report = buildReactionReport(budgeted, windowMs);
      // carry session health — a throttled tab means the observed timeline may be incomplete.
      return Promise.resolve(
        withControl(session, {
          ...report,
          cost: costHint(report, budgeted.length, droppedOldest),
          ...healthEnvelope(session),
        }),
      );
    },
  },
  {
    name: IrisTool.WAIT_FOR,
    description:
      'Block until a predicate is satisfied (or already true in the recent buffer), else time out. Returns matching evidence or a near-miss diagnosis. By default it only counts events since your last act, so a signal buffered BEFORE the action can never fake a pass; pass `since` (an observe/act cursor) to widen or narrow that window explicitly.',
    inputSchema: {
      predicate: PredicateSchema.describe(
        'Predicate to wait for: { signal }, { net }, { element } or a combination.',
      ),
      timeout_ms: z.number().optional().describe('Maximum wait in milliseconds. Default: 4000.'),
      since: z
        .number()
        .optional()
        .describe('Cursor from a prior iris_act — scopes the wait to events after that act.'),
      ...sessionIdShape,
    },
    outputSchema: {
      pass: z.boolean(),
      evidence: z.unknown().optional(),
      failureReason: z.string().optional(),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const predicate = PredicateSchema.parse(args['predicate']);
      // Honesty: explicit since wins; else default to the last act's cursor; else the whole buffer.
      const since = asNumber(args['since']) ?? session.lastActCursor() ?? 0;
      const verdict = await waitForPredicate(
        session,
        predicate,
        asNumber(args['timeout_ms']) ?? 4000,
        since,
      );
      // match iris_assert — wrap with control + session health (throttle matters most while blocking).
      return withControl(session, { ...verdict, ...healthEnvelope(session) });
    },
  },
  {
    name: IrisTool.ASSERT,
    description:
      'Evaluate a predicate (optionally waiting up to timeout_ms). Returns { pass, evidence, failureReason? }. The end of every verify loop. By default it only counts events since your last act, so a stale buffered signal can never fake a pass; pass `since` (an observe/act cursor) to set the window explicitly.',
    inputSchema: {
      predicate: PredicateSchema.describe(
        'Predicate to evaluate: { signal }, { net }, { element } or a combination.',
      ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'If > 0, wait up to this many milliseconds before failing. Default: 0 (evaluate once).',
        ),
      since: z
        .number()
        .optional()
        .describe('Cursor from a prior iris_act — scopes the assertion to events after that act.'),
      ...sessionIdShape,
    },
    outputSchema: {
      pass: z.boolean(),
      evidence: z.unknown().optional(),
      failureReason: z.string().optional(),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const predicate = PredicateSchema.parse(args['predicate']);
      const timeout = asNumber(args['timeout_ms']) ?? 0;
      // Honesty: explicit since wins; else default to the last act's cursor; else the whole buffer.
      const since = asNumber(args['since']) ?? session.lastActCursor() ?? 0;
      const verdict =
        timeout > 0
          ? await waitForPredicate(session, predicate, timeout, since)
          : await evaluatePredicate(session, predicate, since);
      return withControl(session, { ...verdict, ...healthEnvelope(session) });
    },
  },
  {
    name: IrisTool.NETWORK,
    description:
      'Filtered list of network calls. Fast path for "did POST /x return 200?". A zero-match filter returns a `hint` { totalInWindow, present[] } of the calls that DID fire, so a miss is diagnosable.',
    inputSchema: {
      since: z
        .number()
        .optional()
        .describe(
          'Cursor from a prior iris_act — scopes the query to requests fired after that act.',
        ),
      method: z
        .string()
        .optional()
        .describe('HTTP method filter: GET | POST | PUT | DELETE | PATCH etc.'),
      urlContains: z.string().optional().describe('Substring that the request URL must contain.'),
      status: z.number().optional().describe('HTTP status code filter (e.g. 200, 404, 500).'),
      ...sessionIdShape,
    },
    outputSchema: {
      calls: z.array(z.unknown()),
      hint: z.object({ totalInWindow: z.number(), present: z.array(z.string()) }).optional(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const method = asString(args['method']);
      const urlContains = asString(args['urlContains']);
      const status = asNumber(args['status']);
      const allNet = session.eventsSince(since).filter((e) => e.type === EventType.NET_REQUEST);
      const calls = allNet.filter((e) => matchNet(e, method, urlContains, status));
      // zero-match filter returns what DID fire, not a bare [].
      if (calls.length === 0 && allNet.length > 0) {
        return Promise.resolve({ calls, hint: netEmptyHint(allNet) });
      }
      return Promise.resolve({ calls });
    },
  },
  {
    name: IrisTool.CONSOLE,
    description:
      'Console/error log. Fast path for "were there any errors during this flow?". When a level filter matches nothing, returns a `hint` { totalInWindow, byLevel } so 0 errors is distinguishable from a silent page.',
    inputSchema: {
      level: z
        .string()
        .optional()
        .describe('Log level filter: error | warn | info | log. Omit to return all levels.'),
      since: z
        .number()
        .optional()
        .describe('Cursor from a prior iris_act — scopes the query to log entries after that act.'),
      ...sessionIdShape,
    },
    outputSchema: {
      logs: z.array(z.unknown()),
      hint: z.object({ totalInWindow: z.number(), byLevel: z.record(z.number()) }).optional(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const level = asString(args['level']);
      const allConsole = session.eventsSince(since).filter(isConsoleEvent);
      const logs = allConsole.filter((e) => matchConsole(e, level));
      // zero matches at this level → report what levels ARE present (not a bare []).
      if (logs.length === 0 && allConsole.length > 0) {
        return Promise.resolve({ logs, hint: consoleEmptyHint(allConsole) });
      }
      return Promise.resolve({ logs });
    },
  },
  {
    name: IrisTool.ANIMATIONS,
    description: 'Currently running + recently completed animations with targets/timing.',
    inputSchema: { ...sessionIdShape },
    outputSchema: {
      animations: z.array(z.unknown()),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.ANIMATIONS, {}),
  },
  {
    name: IrisTool.BASELINE_SAVE,
    description:
      'Snapshot the current semantic state under a name, to diff against later (regression detection).',
    inputSchema: {
      name: z
        .string()
        .describe(
          'Label for this baseline snapshot (e.g. "dashboard-initial"). Use the same name in iris_diff to compare.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      baseline: z.string().describe('Saved baseline name — pass to iris_diff to compare.'),
      lineCount: z.number(),
    },
    handler: async (deps, args) => {
      const name = asString(args['name']) ?? 'default';
      const { lines, route } = await snapshotTree(deps, asString(args['sessionId']));
      deps.baselines.save({ name, lines, route });
      return { baseline: name, lineCount: lines.length };
    },
  },
  {
    name: IrisTool.BASELINE_LIST,
    description: 'List saved baseline names.',
    inputSchema: {},
    outputSchema: {
      baselines: z.array(z.string()),
    },
    handler: (deps) => Promise.resolve({ baselines: deps.baselines.list() }),
  },
  {
    name: IrisTool.DIFF,
    description:
      'Diff current semantic state vs a saved baseline: REMOVED/ADDED elements + console-error count. Call iris_baseline_list to list saved baselines, iris_baseline_save to create one. Pass `baseline` (name from iris_baseline_list). Answers "did anything silently go missing/break?".',
    inputSchema: {
      baseline: z
        .string()
        .describe(
          'Baseline name to compare against. Call iris_baseline_list to get available names; names are created by iris_baseline_save.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      baseline: z.string(),
      removed: z.array(z.string()),
      added: z.array(z.string()),
      consoleErrors: z.number(),
      routeChanged: z.boolean(),
    },
    handler: async (deps, args) => {
      const name = asString(args['baseline']) ?? 'default';
      const base = deps.baselines.get(name);
      if (base === undefined) throw new Error(`no baseline named '${name}'`);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const { lines, route } = await snapshotTree(deps, asString(args['sessionId']));
      const { removed, added } = diffLines(base.lines, lines);
      const consoleErrors = session
        .eventsSince(0)
        .filter(
          (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
        ).length;
      return { baseline: name, removed, added, consoleErrors, routeChanged: base.route !== route };
    },
  },
  {
    name: IrisTool.RECORD_START,
    description: 'Start recording the event timeline under a name (for replay / a flow report).',
    inputSchema: {
      recordingName: z
        .string()
        .describe(
          'Identifier for this recording. Pass the same name to iris_record_stop and iris_replay.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      recordingName: z.string(),
      since: z.number(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['recordingName']) ?? 'default';
      const cursor = session.elapsed();
      deps.recordings.start(name, cursor);
      return Promise.resolve({ recordingName: name, since: cursor });
    },
  },
  {
    name: IrisTool.RECORD_STOP,
    description:
      'Stop the recording identified by `recordingName` and return both the reaction report for the span and a compiled, replayable { program: { version, steps:[{tool,args,stable}] } } of the agent acts captured during it.',
    inputSchema: {
      recordingName: z
        .string()
        .describe('Identifier of an active recording started with iris_record_start.'),
      ...sessionIdShape,
    },
    outputSchema: {
      recordingName: z.string(),
      program: z.unknown(),
      warning: z.string().optional(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['recordingName']) ?? 'default';
      const rec = deps.recordings.stop(name);
      if (rec === undefined) throw new Error(`no active recording named '${name}'`);
      const events = session.eventsSince(rec.cursor);
      const program: CompiledProgram = {
        name,
        version: REPLAY_PROGRAM_VERSION,
        steps: rec.steps,
      };
      deps.recordings.saveCompiled(program);
      const unstable = rec.steps.filter((s) => !s.stable).length;
      const report = buildReactionReport(events, session.elapsed() - rec.cursor);
      return Promise.resolve({
        recordingName: name,
        program,
        ...(unstable > 0
          ? {
              warning: `${String(unstable)} step(s) not bound to a testid; replay may be brittle (in-session only)`,
            }
          : {}),
        ...report,
        cost: costHint(report, events.length),
      });
    },
  },
  {
    name: IrisTool.REPLAY,
    description:
      'Re-execute a previously recorded program by recordingName. Re-resolves each step to its element by testid (falling back to the stored ref for unstable steps) and runs the actions in order against the live session. Stops at the first failure. Returns { ok, steps:[{tool,ok,error?,note?}] }.',
    inputSchema: {
      recordingName: z
        .string()
        .describe('Name of a compiled recording (from iris_record_stop) to re-execute.'),
      ...sessionIdShape,
    },
    outputSchema: {
      recordingName: z.string(),
      ok: z.boolean(),
      steps: z.array(
        z.object({
          tool: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
    },
    handler: async (deps, args) => {
      const name = asString(args['recordingName']) ?? 'default';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) throw new Error(`no compiled recording named '${name}'`);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = session.elapsed();
      const steps = await replayProgram(session, program);
      return { recordingName: name, since, steps, ok: steps.every((s) => s.ok) };
    },
  },
  {
    name: IrisTool.NARRATE,
    description:
      'Narrate your intent on the page (presenter HUD) so the human watching sees what you are about to do and why. Use a short sentence before a meaningful action.',
    inputSchema: {
      text: z
        .string()
        .describe(
          'Short sentence describing your next action, shown on the presenter HUD for the developer watching.',
        ),
      level: z
        .string()
        .optional()
        .describe('Display severity: info | warn | error. Default: info.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.NARRATE, {
        text: args['text'],
        level: args['level'],
      }),
  },
  {
    name: IrisTool.CLOCK,
    description:
      'Control a fake clock: { freeze:true } to freeze time, { advanceMs:N } to fast-forward timers (toasts, debounces, auto-dismiss), { reset:true } to restore. Lets you test time-gated UI deterministically.',
    inputSchema: {
      freeze: z
        .boolean()
        .optional()
        .describe('Freeze the fake clock. Time stops advancing until advanceMs or reset.'),
      advanceMs: z
        .number()
        .optional()
        .describe(
          'Fast-forward time by this many milliseconds — triggers debounces, toasts, auto-dismiss timers.',
        ),
      reset: z.boolean().optional().describe('Restore the real clock.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      elapsed: z.number().optional(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.CLOCK, {
        freeze: args['freeze'],
        advanceMs: args['advanceMs'],
        reset: args['reset'],
      }),
  },
  {
    name: IrisTool.STATE,
    description:
      "Read live framework state without the app pre-broadcasting it. PREFERRED/RELIABLE: `store` reads a registered store (e.g. 'workspace'); omit `store` to read all stores. To avoid paying for a huge store, scope the read: `path` extracts a dot-path sub-tree (e.g. 'captionCache.v3', with numeric array indices), and `depth` collapses anything deeper than N levels to a size marker. A wrong `path` returns { found:false, availableKeys } so it is diagnosable. `ref` attempts a best-effort read of the nearest React component's hook state and is BOUNDED — on failure it returns component: { ok: false, reason: 'component-state-unavailable' }. Without path/depth: returns { stores, storeNames, component? }.",
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe(
          "Element ref — attempts a best-effort read of the nearest React component's hook state.",
        ),
      store: z
        .string()
        .optional()
        .describe("Registered store name (e.g. 'workspace'). Omit to read all stores."),
      path: z
        .string()
        .optional()
        .describe(
          "Dot-path into the store (e.g. 'captionCache.v3'). Numeric array indices are supported.",
        ),
      depth: z
        .number()
        .optional()
        .describe(
          'Collapse anything deeper than N levels to a size marker — avoids huge outputs for large stores.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      stores: z.record(z.unknown()).optional(),
      storeNames: z.array(z.string()).optional(),
      found: z.boolean().optional(),
      value: z.unknown().optional(),
      component: z
        .object({ ok: z.boolean(), reason: z.string().optional(), state: z.unknown().optional() })
        .optional(),
    },
    handler: async (deps, args) => {
      const store = asString(args['store']);
      const result = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        IrisCommand.STATE_READ,
        {
          ref: args['ref'],
          store,
        },
      );
      const path = asString(args['path']);
      const depth = asNumber(args['depth']);
      if (path === undefined && depth === undefined) return result; // unchanged shape

      // Base for the path is the named store's value (else the whole result when no store is given).
      const root = result as { stores?: Record<string, unknown>; storeNames?: unknown };
      const base = store !== undefined ? (root.stores ?? {})[store] : result;
      const selection = path !== undefined ? selectPath(base, path) : { found: true, value: base };
      const value =
        selection.found && depth !== undefined ? capDepth(selection.value, depth) : selection.value;
      return {
        store,
        path,
        ...selection,
        value,
        storeNames: root.storeNames,
      };
    },
  },
  {
    name: IrisTool.EXPLORE,
    description:
      'Autonomous-exploration helper: list interactive elements (with refs) + current console-error count, so the agent can drive the app and report anomalies.',
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          'CSS selector or element ref to restrict the interactive element list to a subtree.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      interactive: z.array(z.unknown()),
      consoleErrors: z.number(),
      hint: z.string(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const result = await session.command(IrisCommand.SNAPSHOT, {
        mode: SnapshotMode.INTERACTIVE,
        scope: args['scope'],
      });
      if (!result.ok) throw new Error(result.error ?? 'snapshot failed');
      const snap = (result.result ?? {}) as { tree?: string };
      const consoleErrors = session
        .eventsSince(0)
        .filter(
          (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
        ).length;
      return {
        interactive: parseInteractive(snap.tree ?? ''),
        consoleErrors,
        hint: 'act on each ref, observe the reaction, and report failed requests / console errors / dead controls',
      };
    },
  },
  // iris_capabilities (live | fromDisk) + iris_contract_save. See contract-tools.ts.
  ...CONTRACT_TOOLS,
  // iris_flow_save / iris_flow_list / iris_flow_load. See flow-tools.ts.
  ...FLOW_TOOLS,
  // iris_project (read history + diff-vs-last) / iris_run_record. See project-tools.ts.
  ...PROJECT_TOOLS,
  // iris_screenshot / iris_visual_diff — opt-in, CDP-driven. See visual-tools.ts.
  ...VISUAL_TOOLS,
  // iris_crawl — autonomous click-everything + anomaly report. See crawl-tools.ts.
  ...CRAWL_TOOLS,
  // iris_scroll_to — reveal a virtualized off-screen row. See scroll-tools.ts.
  ...SCROLL_TOOLS,
  // Session lifecycle: iris_session — tune the presenter session (idle-end). See session-tools.ts.
  ...SESSION_TOOLS,
  // iris_annotate (structured annotation → expect/dynamic/success). See annotate-tools.ts.
  ...ANNOTATE_TOOLS,
  // Live-control: iris_end_session / iris_resume / iris_messages. See live-control-tools.ts.
  ...LIVE_CONTROL_TOOLS,
  // iris_navigate / iris_refresh — browser navigation tools. See browser-tools.ts.
  ...BROWSER_TOOLS,
];

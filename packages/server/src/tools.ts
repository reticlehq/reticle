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
import type { Session, SessionManager } from './session.js';
import type { ElementBox, RealInputArgs, RealInputProvider } from './real-input.js';
import { isPointerAction } from './real-input.js';
import { IrisTool } from './tool-names.js';
import { buildReactionReport } from './reaction.js';
import { evaluatePredicate, waitForPredicate, PredicateSchema } from './predicate.js';
import { type BaselineStore, normalizeLines, diffLines } from './baselines.js';
import { REPLAY_PROGRAM_VERSION } from '@syrin/iris-protocol';
import type { RecordingStore, CompiledProgram } from './recordings.js';
import { compileActStep, compileSequenceStep, replayProgram } from './replay.js';
import { matchNet, matchConsole } from './event-filters.js';
import { healthEnvelope, refuseIfThrottled } from './session-health.js';
import { asString, asNumber, asRecord, parseInteractive } from './tools-helpers.js';
import type { FileSystemPort } from './fs-port.js';
import type { FlowStore } from './flows.js';
import { CONTRACT_TOOLS } from './contract-tools.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ANNOTATE_TOOLS } from './annotate-tools.js';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import { pausedShortCircuit, withControl } from './control-envelope.js';
import type { AnnotationStore } from './annotation-store.js';

export interface ToolDeps {
  sessions: SessionManager;
  baselines: BaselineStore;
  recordings: RecordingStore;
  /** M8 Stage A FLOWFMT: on-disk anchored-flow store (.iris/flows/). */
  flows: FlowStore;
  /** M8 Stage B ANNOTATE: structured annotations accumulating for the live recording. */
  annotations: AnnotationStore;
  /** R1: optional native-input provider. undefined ⇒ everything stays synthetic. */
  realInput?: RealInputProvider;
  /** M8 Stage A: injected filesystem seam (tests pass a fake/temp-dir adapter). */
  fs: FileSystemPort;
  /** M8 Stage A: absolute .iris path (index.ts computes cwd()/.iris). */
  irisRoot: string;
  /** M8 Stage A: injected clock for the contract's generatedAt stamp. */
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
  handler: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

const sessionIdShape = { sessionId: z.string().optional() };

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

/** R1: narrow an INSPECT result's `box` into a positive-area ElementBox (else undefined). */
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

/** R1: outcome of a real-input attempt — real success (result set) or synthetic with a reason. */
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
 * R1: attempt to drive a pointer action via native input. Returns a synthetic outcome (with a
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
  if (!(await provider.isAvailableFor(session.url)))
    return synthetic(InputModeReason.PAGE_NOT_CORRELATED);

  const box = asBox(await commandOrThrow(deps, session.id, IrisCommand.INSPECT, { ref }));
  if (box === undefined) return synthetic(InputModeReason.ELEMENT_NOT_LOCATABLE);

  const inner = asRecord(args['args']);
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
      scope: z.string().optional(),
      mode: z.nativeEnum(SnapshotMode).optional(),
      ...sessionIdShape,
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
      'Find elements by Testing-Library semantics (role/text/label/placeholder/testid/alt). Returns matching refs + descriptors + visibility. On zero matches, also returns hint:{ route, presentTestids[], knownEmptyState } so you can distinguish an empty state from a missing element WITHOUT taking a snapshot.',
    inputSchema: {
      by: z.string(),
      value: z.string(),
      name: z.string().optional(),
      scope: z.string().optional(),
      ...sessionIdShape,
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
    inputSchema: { ref: z.string(), ...sessionIdShape },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.INSPECT, {
        ref: args['ref'],
      }),
  },
  {
    name: IrisTool.ACT,
    description:
      'Execute one action against a ref: click|dblclick|hover|focus|fill|type|clear|select|check|uncheck|submit|press|scrollIntoView. Returns immediately with a `since` cursor for observe. Result includes effect: { dispatched, targetMatched, visible, enabled, defaultPrevented, focusMoved, valueChanged, domMutatedWithin } so you can tell "action missed" vs "app didn\'t react". Top-level dispatched/settled/settleReason report whether the click landed (dispatched) and whether a real frame flushed (settled) vs a throttled-tab timeout (settleReason:"timeout") — a settle timeout never fails the tool. Every result also carries inputMode. With real-input mode (server cdpUrl/IRIS_CDP_URL set) pointer actions (hover/click/dblclick/drag) are driven via native CDP input and return inputMode:"real" WITHOUT the synthetic `effect` block — observe the reaction with iris_observe. Otherwise inputMode:"synthetic"; when a provider IS configured but a pointer act still ran synthetic, inputModeReason says why (e.g. "page-not-correlated-to-a-cdp-target" right after an SPA navigation, or "element-not-locatable" when off-screen) so the fallback is never silent. Real-input applies to iris_act only (not act_sequence/act_and_wait). When the tab is hidden/throttled, session.recommendation explains the limit (Iris cannot bring such a tab to front) and points to `iris drive` for a guaranteed scriptable context.',
    inputSchema: {
      ref: z.string(),
      action: z.string(),
      args: z.record(z.unknown()).optional(),
      refuseWhenThrottled: z.boolean().optional(),
      ...sessionIdShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // Live-control: refuse to drive the page while the human has paused us (before any work).
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      refuseIfThrottled(session, args['refuseWhenThrottled']);
      const since = session.elapsed();
      const ref = asString(args['ref']) ?? '';
      const action = asString(args['action']) ?? '';

      // R1: drive native pointer input when a provider is available; otherwise fall back.
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
      // F1: lift dispatch/settle status to the envelope (a settle timeout is NOT a failure).
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
      steps: z.array(z.record(z.unknown())),
      ...sessionIdShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // Live-control: refuse to drive the page while the human has paused us (before any work).
      const paused = pausedShortCircuit(session);
      if (paused !== undefined) return paused;
      const since = session.elapsed();
      const result = await session.command(IrisCommand.ACT_SEQUENCE, { steps: args['steps'] });
      if (!result.ok) throw new Error(result.error ?? 'act_sequence failed');
      if (deps.recordings.active().length > 0) {
        deps.recordings.capture(compileSequenceStep(args, result.result));
      }
      const r = asRecord(result.result); // F1: per-step settle status lives in result.steps[]
      return withControl(session, {
        since,
        dispatched: r['count'] !== undefined,
        result: result.result,
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
      ref: z.string(),
      action: z.string(),
      args: z.record(z.unknown()).optional(),
      until: PredicateSchema,
      timeout_ms: z.number().optional(),
      refuseWhenThrottled: z.boolean().optional(),
      ...sessionIdShape,
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
      const actResult = await session.command(IrisCommand.ACT, {
        ref: args['ref'],
        action: args['action'],
        args: args['args'] ?? {},
      });
      if (!actResult.ok) throw new Error(actResult.error ?? 'act failed');

      const verdict =
        timeout > 0
          ? await waitForPredicate(session, until, timeout)
          : await evaluatePredicate(session, until);

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
      'Return the timeline of everything the app did in a window (DOM/network/route/console/animation/signal), with a summary. Use after an action.',
    inputSchema: {
      window_ms: z.number().optional(),
      since: z.number().optional(),
      filters: z.array(z.string()).optional(),
      ...sessionIdShape,
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
      return Promise.resolve(withControl(session, buildReactionReport(filtered, windowMs)));
    },
  },
  {
    name: IrisTool.WAIT_FOR,
    description:
      'Block until a predicate is satisfied (or already true in the recent buffer), else time out. Returns matching evidence or a near-miss diagnosis.',
    inputSchema: {
      predicate: PredicateSchema,
      timeout_ms: z.number().optional(),
      ...sessionIdShape,
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const predicate = PredicateSchema.parse(args['predicate']);
      return waitForPredicate(session, predicate, asNumber(args['timeout_ms']) ?? 4000);
    },
  },
  {
    name: IrisTool.ASSERT,
    description:
      'Evaluate a predicate (optionally waiting up to timeout_ms). Returns { pass, evidence, failureReason? }. The end of every verify loop.',
    inputSchema: {
      predicate: PredicateSchema,
      timeout_ms: z.number().optional(),
      ...sessionIdShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const predicate = PredicateSchema.parse(args['predicate']);
      const timeout = asNumber(args['timeout_ms']) ?? 0;
      const verdict =
        timeout > 0
          ? await waitForPredicate(session, predicate, timeout)
          : await evaluatePredicate(session, predicate);
      return withControl(session, { ...verdict, ...healthEnvelope(session) });
    },
  },
  {
    name: IrisTool.NETWORK,
    description: 'Filtered list of network calls. Fast path for "did POST /x return 200?".',
    inputSchema: {
      since: z.number().optional(),
      method: z.string().optional(),
      urlContains: z.string().optional(),
      status: z.number().optional(),
      ...sessionIdShape,
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const method = asString(args['method']);
      const urlContains = asString(args['urlContains']);
      const status = asNumber(args['status']);
      const calls = session
        .eventsSince(since)
        .filter((e) => e.type === EventType.NET_REQUEST)
        .filter((e) => matchNet(e, method, urlContains, status));
      return Promise.resolve({ calls });
    },
  },
  {
    name: IrisTool.CONSOLE,
    description: 'Console/error log. Fast path for "were there any errors during this flow?".',
    inputSchema: {
      level: z.string().optional(),
      since: z.number().optional(),
      ...sessionIdShape,
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const level = asString(args['level']);
      const logs = session.eventsSince(since).filter((e) => matchConsole(e, level));
      return Promise.resolve({ logs });
    },
  },
  {
    name: IrisTool.ANIMATIONS,
    description: 'Currently running + recently completed animations with targets/timing.',
    inputSchema: { ...sessionIdShape },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.ANIMATIONS, {}),
  },
  {
    name: IrisTool.BASELINE_SAVE,
    description:
      'Snapshot the current semantic state under a name, to diff against later (regression detection).',
    inputSchema: { name: z.string(), ...sessionIdShape },
    handler: async (deps, args) => {
      const name = asString(args['name']) ?? 'default';
      const { lines, route } = await snapshotTree(deps, asString(args['sessionId']));
      deps.baselines.save({ name, lines, route });
      return { name, lineCount: lines.length };
    },
  },
  {
    name: IrisTool.BASELINE_LIST,
    description: 'List saved baseline names.',
    inputSchema: {},
    handler: (deps) => Promise.resolve({ baselines: deps.baselines.list() }),
  },
  {
    name: IrisTool.DIFF,
    description:
      'Diff current semantic state vs a saved baseline: REMOVED/ADDED elements + console-error count. Answers "did anything silently go missing/break?".',
    inputSchema: { baseline: z.string(), ...sessionIdShape },
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
    inputSchema: { name: z.string(), ...sessionIdShape },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['name']) ?? 'default';
      const cursor = session.elapsed();
      deps.recordings.start(name, cursor);
      return Promise.resolve({ name, since: cursor });
    },
  },
  {
    name: IrisTool.RECORD_STOP,
    description:
      'Stop a recording and return both the ordered reaction report for the span and a compiled, replayable { program: { version, steps:[{tool,args,stable}] } } of the agent acts captured during it.',
    inputSchema: { name: z.string(), ...sessionIdShape },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['name']) ?? 'default';
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
      return Promise.resolve({
        name,
        program,
        ...(unstable > 0
          ? {
              warning: `${String(unstable)} step(s) not bound to a testid; replay may be brittle (in-session only)`,
            }
          : {}),
        ...buildReactionReport(events, session.elapsed() - rec.cursor),
      });
    },
  },
  {
    name: IrisTool.REPLAY,
    description:
      'Re-execute a previously recorded program by name. Re-resolves each step to its element by testid (falling back to the stored ref for unstable steps) and runs the actions in order against the live session. Stops at the first failure. Returns { ok, steps:[{tool,ok,error?,note?}] }.',
    inputSchema: { name: z.string(), ...sessionIdShape },
    handler: async (deps, args) => {
      const name = asString(args['name']) ?? 'default';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) throw new Error(`no compiled recording named '${name}'`);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = session.elapsed();
      const steps = await replayProgram(session, program);
      return { name, since, steps, ok: steps.every((s) => s.ok) };
    },
  },
  {
    name: IrisTool.NARRATE,
    description:
      'Narrate your intent on the page (presenter HUD) so the human watching sees what you are about to do and why. Use a short sentence before a meaningful action.',
    inputSchema: { text: z.string(), level: z.string().optional(), ...sessionIdShape },
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
      freeze: z.boolean().optional(),
      advanceMs: z.number().optional(),
      reset: z.boolean().optional(),
      ...sessionIdShape,
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
      "Read live framework state without the app pre-broadcasting it. PREFERRED/RELIABLE: `store` reads a registered store (e.g. 'workspace'); omit `store` to read all stores. `ref` attempts a best-effort read of the nearest React component's hook state and is BOUNDED — if it cannot be read it returns component: { ok: false, reason: 'component-state-unavailable' } rather than hanging or erroring; on success component is { ok: true, component, hooks }. Returns { stores, storeNames, component? }.",
    inputSchema: {
      ref: z.string().optional(),
      store: z.string().optional(),
      ...sessionIdShape,
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.STATE_READ, {
        ref: args['ref'],
        store: args['store'],
      }),
  },
  {
    name: IrisTool.EXPLORE,
    description:
      'Autonomous-exploration helper: list interactive elements (with refs) + current console-error count, so the agent can drive the app and report anomalies.',
    inputSchema: { scope: z.string().optional(), ...sessionIdShape },
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
  // M8 Stage A: iris_capabilities (live | fromDisk) + iris_contract_save. See contract-tools.ts.
  ...CONTRACT_TOOLS,
  // M8 Stage A FLOWFMT: iris_flow_save / iris_flow_list / iris_flow_load. See flow-tools.ts.
  ...FLOW_TOOLS,
  // M8 Stage B ANNOTATE: iris_annotate (structured annotation → expect/dynamic/success). See annotate-tools.ts.
  ...ANNOTATE_TOOLS,
  // Live-control: iris_end_session / iris_resume / iris_messages. See live-control-tools.ts.
  ...LIVE_CONTROL_TOOLS,
];

import { z } from 'zod';
import { EventType, IrisCommand, SnapshotMode } from '@iris/protocol';
import type { SessionManager } from './session.js';
import { IrisTool } from './tool-names.js';
import { buildReactionReport } from './reaction.js';
import { evaluatePredicate, waitForPredicate, PredicateSchema } from './predicate.js';
import { type BaselineStore, normalizeLines, diffLines } from './baselines.js';
import { REPLAY_PROGRAM_VERSION } from '@iris/protocol';
import type { RecordingStore, CompiledProgram } from './recordings.js';
import { compileActStep, compileSequenceStep, replayProgram } from './replay.js';
import { matchNet, matchConsole } from './event-filters.js';
import { healthEnvelope, refuseIfThrottled } from './session-health.js';
import { asString, asNumber, asRecord, parseInteractive } from './tools-helpers.js';

export interface ToolDeps {
  sessions: SessionManager;
  baselines: BaselineStore;
  recordings: RecordingStore;
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

export const TOOLS: ToolDef[] = [
  {
    name: IrisTool.SESSIONS,
    description:
      'List connected browser sessions (tab url/title, sessionId, last-seen, and health: hidden/focused/throttled).',
    inputSchema: {},
    handler: (deps) => Promise.resolve({ sessions: deps.sessions.list() }),
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
      'Deep info on one element by ref: full a11y props, visibility, box, and (with @iris/react) component stack + source file.',
    inputSchema: { ref: z.string(), ...sessionIdShape },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.INSPECT, {
        ref: args['ref'],
      }),
  },
  {
    name: IrisTool.ACT,
    description:
      'Execute one action against a ref: click|dblclick|hover|focus|fill|type|clear|select|check|uncheck|submit|press|scrollIntoView. Returns immediately with a `since` cursor for observe. Result includes effect: { dispatched, targetMatched, visible, enabled, defaultPrevented, focusMoved, valueChanged, domMutatedWithin } so you can tell "action missed" vs "app didn\'t react". Top-level dispatched/settled/settleReason report whether the click landed (dispatched) and whether a real frame flushed (settled) vs a throttled-tab timeout (settleReason:"timeout") — a settle timeout never fails the tool.',
    inputSchema: {
      ref: z.string(),
      action: z.string(),
      args: z.record(z.unknown()).optional(),
      refuseWhenThrottled: z.boolean().optional(),
      ...sessionIdShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      refuseIfThrottled(session, args['refuseWhenThrottled']);
      const since = session.elapsed();
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
      return {
        since,
        dispatched: r['dispatched'] ?? true,
        settled: r['settled'] ?? null,
        settleReason: r['settleReason'] ?? null,
        result: result.result,
        ...healthEnvelope(session),
      };
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
      const since = session.elapsed();
      const result = await session.command(IrisCommand.ACT_SEQUENCE, { steps: args['steps'] });
      if (!result.ok) throw new Error(result.error ?? 'act_sequence failed');
      if (deps.recordings.active().length > 0) {
        deps.recordings.capture(compileSequenceStep(args, result.result));
      }
      const r = asRecord(result.result); // F1: per-step settle status lives in result.steps[]
      return { since, dispatched: r['count'] !== undefined, result: result.result };
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
      return { effect: actResult.result, verdict, trace, ...healthEnvelope(session) };
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
      return Promise.resolve(buildReactionReport(filtered, windowMs));
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
      return { ...verdict, ...healthEnvelope(session) };
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
    name: IrisTool.CAPABILITIES,
    description:
      'The app-advertised testable surface (iris.describe): testids, signals, stores, and named flows. Call this first to learn what to assert on without reading source.',
    inputSchema: { ...sessionIdShape },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.CAPABILITIES, {}),
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
      "Read live framework state without the app pre-broadcasting it. `store` reads a registered store (e.g. 'workspace'); omit to read all. `ref` reads the nearest React component's hook state for that element (best-effort). Returns { stores, storeNames, component? }.",
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
];

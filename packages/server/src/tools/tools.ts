import { z } from 'zod';
import { EventType, IrisCommand, SnapshotMode } from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { buildReactionReport } from '../events/reaction.js';
import { evaluatePredicate, waitForPredicate, PredicateSchema } from '../events/predicate.js';
import { diffLines } from '../project/baselines.js';
import { REPLAY_PROGRAM_VERSION } from '@syrin/iris-protocol';
import type { CompiledProgram } from '../flows/recordings.js';
import { replayProgram } from '../flows/replay.js';
import {
  matchNet,
  matchConsole,
  isConsoleEvent,
  netEmptyHint,
  consoleEmptyHint,
  reconcileNet,
  projectNetCall,
  projectConsoleLog,
} from '../events/event-filters.js';
import { healthEnvelope } from '../session/session-health.js';
import { applyEventBudget, costHint, withSizeCost } from '../session/output-budget.js';
import { applySnapshotDelta, SnapshotCache } from './snapshot-delta.js';
import { selectPath, capDepth } from '../session/state-select.js';
import { asString, asNumber, parseInteractive } from './tools-helpers.js';
import { paginateQueryResult } from './query-paginate.js';
import { isPresenceOnlyAssertion, PRESENCE_ONLY_ADVICE } from './assert-grade.js';
import { CONTRACT_TOOLS } from './contract-tools.js';
import { DOMAIN_TOOLS } from '../domain/domain-tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import { FLOW_TOOLS } from '../flows/flow-tools.js';
import { PROJECT_TOOLS } from '../project/project-tools.js';
import { VISUAL_TOOLS } from '../visual/visual-tools.js';
import { CRAWL_TOOLS } from '../crawl/crawl-tools.js';
import { SCROLL_TOOLS } from '../input/scroll-tools.js';
import { SESSION_TOOLS } from '../session/session-tools.js';
import { ANNOTATE_TOOLS } from '../flows/annotate-tools.js';
import { LIVE_CONTROL_TOOLS } from '../session/live-control-tools.js';
import { withControl } from '../session/control-envelope.js';
import { UPDATE_TOOLS } from '../update/update-tools.js';
import { type ToolDef, sessionIdShape, commandOrThrow, snapshotTree } from './tool-kit.js';
import { ACT_TOOLS } from './act-tools.js';

// Re-exported so tool modules that import these from './tools.js' keep working after the kit move.
export type { ToolDef, ToolDeps } from './tool-kit.js';

/** Per-server last-snapshot cache backing iris_snapshot's diff:true delta mode (route-invalidated). */
const SNAPSHOT_CACHE = new SnapshotCache();

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
      'Semantic accessibility snapshot of the page or a subtree. mode: full|interactive|status. Use to see what is on screen right now. The result carries cost:{ bytes, tokens } (estimated) — if it is large, re-scope (pass `scope`) or use mode:interactive/status instead of reading the whole tree. Pass diff:true after your first snapshot to get back ONLY what changed since your last look (mode:delta with added/removed, or mode:unchanged) — far fewer tokens and no stale tree to mis-read; a route change resets it to a full snapshot automatically.',
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
      diff: z
        .boolean()
        .optional()
        .describe(
          'Return only what changed since your last snapshot of the same scope/mode (mode:delta|unchanged). First call (or after a route change) still returns the full tree.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      tree: z
        .string()
        .optional()
        .describe('Indented ARIA tree of every element on the page (or the scoped subtree).'),
      status: z.object({ route: z.string(), title: z.string().optional() }).optional(),
      mode: z
        .string()
        .optional()
        .describe('delta | unchanged when diff:true returned a change set.'),
      delta: z
        .object({
          added: z.array(z.string()),
          removed: z.array(z.string()),
          addedCount: z.number(),
          removedCount: z.number(),
        })
        .optional()
        .describe('Only present on a diff:true call that found changes.'),
      cost: z
        .object({ bytes: z.number(), tokens: z.number() })
        .optional()
        .describe('Estimated size of this result — re-scope if large.'),
    },
    handler: (deps, args) => {
      const sessionId = asString(args['sessionId']);
      const mode = asString(args['mode']) ?? SnapshotMode.FULL;
      return commandOrThrow(deps, sessionId, IrisCommand.SNAPSHOT, {
        scope: args['scope'],
        mode,
      }).then((raw) =>
        withSizeCost(
          applySnapshotDelta(
            raw,
            {
              sessionId: sessionId ?? 'default',
              scope: asString(args['scope']) ?? '',
              mode,
              diff: args['diff'] === true,
            },
            SNAPSHOT_CACHE,
          ),
        ),
      );
    },
  },
  {
    name: IrisTool.QUERY,
    description:
      'Find elements by Testing-Library semantics. Pass `by` (role|text|label|placeholder|testid|alt) and `value` (the query string). Returns matching refs + descriptors + visibility. Pass `limit` to cap descriptors (broad role queries can be large) or `count_only:true` for just the match count — both cut tokens. On zero matches, also returns hint:{ route, presentTestids[], knownEmptyState } so you can distinguish an empty state from a missing element WITHOUT taking a snapshot.',
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
      limit: z
        .number()
        .optional()
        .describe(
          'Cap the returned descriptors to the first N (cuts tokens on broad queries). If more matched, the result carries total + truncated:true so the trim is never silent — narrow with name/scope.',
        ),
      count_only: z
        .boolean()
        .optional()
        .describe(
          'Return just { count } (no element descriptors) — use when you only need "how many match?" and not their refs.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      elements: z
        .array(
          z.object({
            ref: z.string(),
            role: z.string(),
            name: z.string(),
            value: z.string().optional(),
            states: z.array(z.string()),
            visible: z.boolean(),
          }),
        )
        .optional(),
      count: z.number().optional().describe('Match count — present when count_only is set.'),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` truncation — present only when truncated.'),
      truncated: z.boolean().optional().describe('True when `limit` dropped some matches.'),
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
      cost: z
        .object({ bytes: z.number(), tokens: z.number() })
        .optional()
        .describe('Estimated size of this result — narrow with `name`/`scope`/`limit` if large.'),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.QUERY, {
        by: args['by'],
        value: args['value'],
        name: args['name'],
        scope: args['scope'],
      }).then((result) =>
        withSizeCost(
          paginateQueryResult(result, asNumber(args['limit']), args['count_only'] === true),
        ),
      ),
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
      // True when another element covers this one's center (z-index/overlay bug — unclickable).
      occluded: z.boolean().optional(),
      // Computed style the a11y tree omits: cursor/display/visibility/color so a "present but
      // unusable" UI bug (dead cursor, invisible, recolored) is observable in one inspect.
      styles: z
        .object({
          color: z.string(),
          backgroundColor: z.string(),
          opacity: z.string(),
          cursor: z.string(),
          display: z.string(),
          visibility: z.string(),
        })
        .partial()
        .optional(),
      // Theme compliance vs the app's design tokens: { colorToken, backgroundToken (null = off-palette),
      // offTheme, tokenCount }. Kept as unknown — the structured-content serializer can truncate a
      // large inspect payload's fields to strings, which a strict shape would reject; the full object
      // is always present in the text content the agent reads.
      theme: z.unknown().optional(),
      component: z
        .object({ name: z.string().optional(), sourceFile: z.string().optional() })
        .optional(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), IrisCommand.INSPECT, {
        ref: args['ref'],
      }),
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
        recommendation: z
          .string()
          .optional()
          .describe(
            'Present when the timeline is large — scope your next call (filters/max_events).',
          ),
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
        'Predicate to wait for: { signal }, { net }, { element }, { kind: "state", store, path, equals } (assert a registered store\'s value directly — the source of truth no DOM read can reach; equals takes a literal or { $gte | $contains | $length } pattern), { kind: "settled", quietMs } (deterministic network + DOM idle — prefer this over a fixed sleep), or a combination via allOf/anyOf.',
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
      'Evaluate a predicate (optionally waiting up to timeout_ms). Returns { pass, evidence, failureReason? }. The end of every verify loop. Prefer a { signal } or { net } consequence over { element }/{ text } presence — a passing presence-only assertion returns `advice` because a wrong/healed element can fake it. By default it only counts events since your last act, so a stale buffered signal can never fake a pass; pass `since` (an observe/act cursor) to set the window explicitly.',
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
      advice: z
        .string()
        .optional()
        .describe('Present on a PASSING presence-only assertion — nudges toward a consequence.'),
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
      // A GREEN presence-only assertion is the dangerous case (a wrong element can fake it) — nudge
      // toward a consequence. Never on a failing verdict (moot) or when a signal/net is asserted.
      const advice =
        verdict.pass && isPresenceOnlyAssertion(predicate) ? { advice: PRESENCE_ONLY_ADVICE } : {};
      return withControl(session, { ...verdict, ...advice, ...healthEnvelope(session) });
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
      limit: z
        .number()
        .optional()
        .describe(
          'Keep only the most recent N matching calls (older are dropped and counted in droppedOldest) — cuts tokens on a wide window.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      calls: z.array(z.unknown()),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` — present only when capped.'),
      droppedOldest: z.number().optional().describe('How many older matches `limit` dropped.'),
      hint: z.object({ totalInWindow: z.number(), present: z.array(z.string()) }).optional(),
      cost: z.object({ bytes: z.number(), tokens: z.number() }).optional(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const method = asString(args['method']);
      const urlContains = asString(args['urlContains']);
      const status = asNumber(args['status']);
      const limit = asNumber(args['limit']);
      // Completed calls + unresolved in-flight requests (a hung request shows as pending).
      const allNet = reconcileNet(session.eventsSince(since));
      const matched = allNet.filter((e) => matchNet(e, method, urlContains, status));
      // zero-match filter returns what DID fire, not a bare [].
      if (matched.length === 0 && allNet.length > 0) {
        return Promise.resolve(withSizeCost({ calls: matched, hint: netEmptyHint(allNet) }));
      }
      const { events: budgeted, droppedOldest } = applyEventBudget(matched, limit);
      const calls = budgeted.map(projectNetCall);
      return Promise.resolve(
        withSizeCost(
          droppedOldest > 0 ? { calls, total: matched.length, droppedOldest } : { calls },
        ),
      );
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
      limit: z
        .number()
        .optional()
        .describe(
          'Keep only the most recent N matching entries (older are dropped and counted in droppedOldest) — cuts tokens when a page spams the console.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      logs: z.array(z.unknown()),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` — present only when capped.'),
      droppedOldest: z.number().optional().describe('How many older matches `limit` dropped.'),
      hint: z.object({ totalInWindow: z.number(), byLevel: z.record(z.number()) }).optional(),
      cost: z.object({ bytes: z.number(), tokens: z.number() }).optional(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const level = asString(args['level']);
      const limit = asNumber(args['limit']);
      const allConsole = session.eventsSince(since).filter(isConsoleEvent);
      const matched = allConsole.filter((e) => matchConsole(e, level));
      // zero matches at this level → report what levels ARE present (not a bare []).
      if (matched.length === 0 && allConsole.length > 0) {
        return Promise.resolve(withSizeCost({ logs: matched, hint: consoleEmptyHint(allConsole) }));
      }
      const { events: budgeted, droppedOldest } = applyEventBudget(matched, limit);
      const logs = budgeted.map(projectConsoleLog);
      return Promise.resolve(
        withSizeCost(droppedOldest > 0 ? { logs, total: matched.length, droppedOldest } : { logs }),
      );
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
      'Re-execute a previously recorded program by recordingName. Re-resolves each step to its element by testid (falling back to the stored ref for unstable steps) and runs the actions in order against the live session. Stops at the first failure. Destructive controls require confirmDangerous:true on every replay; confirmation is never persisted. Returns { ok, steps:[{tool,ok,error?,note?}] }.',
    inputSchema: {
      recordingName: z
        .string()
        .describe('Name of a compiled recording (from iris_record_stop) to re-execute.'),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this replay only.'),
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
      const steps = await replayProgram(session, program, args['confirmDangerous'] === true);
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
    outputSchema: { ok: z.boolean() },
    handler: async (deps, args) => {
      const result = (await commandOrThrow(deps, asString(args['sessionId']), IrisCommand.NARRATE, {
        text: args['text'],
        level: args['level'],
      })) as Record<string, unknown>;
      return { ok: true, ...result };
    },
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
      ok: z.boolean().optional(),
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
      const path = asString(args['path']);
      const depth = asNumber(args['depth']);
      // Forward path/depth so a CURRENT browser SDK scopes the read IN-PAGE, before the transport —
      // the value never gets size-truncated in transit. (An older SDK ignores them and returns the
      // whole store; we then scope server-side below as a back-compat fallback.)
      const result = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        IrisCommand.STATE_READ,
        {
          ref: args['ref'],
          store,
          path,
          depth,
        },
      );
      // Normalize storeNames to a string[] regardless of how the wire delivered it — the
      // outputSchema requires an array, and a non-array here makes MCP reject the whole result
      // (so the agent gets nothing instead of the state). Defensive: a string becomes a 1-element array.
      const root = result as {
        stores?: Record<string, unknown>;
        storeNames?: unknown;
        found?: unknown;
      };
      const names = Array.isArray(root.storeNames)
        ? root.storeNames.filter((n): n is string => typeof n === 'string')
        : typeof root.storeNames === 'string' && root.storeNames.length > 0
          ? [root.storeNames]
          : [];

      // The browser already scoped it in-page (the `found` shape) — pass through, just safe storeNames.
      if (typeof root.found === 'boolean') {
        return { ...(root as Record<string, unknown>), storeNames: names };
      }

      if (path === undefined && depth === undefined) {
        return { ...(root as Record<string, unknown>), storeNames: names }; // unchanged shape, safe storeNames
      }

      // Back-compat: an older browser returned the whole store; scope it here (may already be
      // size-truncated in transit for a very large store — that is the limitation this fix removes
      // for current SDKs).
      const base = store !== undefined ? (root.stores ?? {})[store] : result;
      const selection = path !== undefined ? selectPath(base, path) : { found: true, value: base };
      const value =
        selection.found && depth !== undefined ? capDepth(selection.value, depth) : selection.value;
      return {
        store,
        path,
        ...selection,
        value,
        storeNames: names,
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
  ...DOMAIN_TOOLS,
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
  // iris_version_info / iris_apply_update / iris_rollback — update lifecycle tools.
  ...UPDATE_TOOLS,
  ...ACT_TOOLS,
];

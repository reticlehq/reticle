/**
 * Read / record / replay tools — baselines + diff, recordings + replay, narrate, clock, state,
 * explore. Split out of tools.ts; assembled back via ...READ_TOOLS.
 */
import { z } from 'zod';
import { EventType, ReticleCommand, REPLAY_PROGRAM_VERSION, SnapshotMode } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import type { CompiledProgram } from '../flows/recordings.js';
import { replayProgram } from '../flows/replay.js';
import { diffLines } from '../project/baselines.js';
import { selectPath, capDepth } from '../session/state-select.js';
import { costHint } from '../session/output-budget.js';
import { buildReactionReport } from '../events/reaction.js';
import { asString, asNumber, parseInteractive } from './tools-helpers.js';
import { type ToolDef, sessionIdShape, commandOrThrow, snapshotTree } from './tool-kit.js';

export const READ_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.BASELINE_SAVE,
    description:
      'Snapshot the current semantic state under a name, to diff against later (regression detection).',
    inputSchema: {
      name: z
        .string()
        .describe(
          'Label for this baseline snapshot (e.g. "dashboard-initial"). Use the same name in reticle_diff to compare.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      baseline: z.string().describe('Saved baseline name — pass to reticle_diff to compare.'),
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
    name: ReticleTool.BASELINE_LIST,
    description: 'List saved baseline names.',
    inputSchema: {},
    outputSchema: {
      baselines: z.array(z.string()),
    },
    handler: (deps) => Promise.resolve({ baselines: deps.baselines.list() }),
  },
  {
    name: ReticleTool.DIFF,
    description:
      'Diff current semantic state vs a saved baseline: REMOVED/ADDED elements + console-error count. Call reticle_baseline_list to list saved baselines, reticle_baseline_save to create one. Pass `baseline` (name from reticle_baseline_list). Answers "did anything silently go missing/break?".',
    inputSchema: {
      baseline: z
        .string()
        .describe(
          'Baseline name to compare against. Call reticle_baseline_list to get available names; names are created by reticle_baseline_save.',
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
    name: ReticleTool.RECORD_START,
    description: 'Start recording the event timeline under a name (for replay / a flow report).',
    inputSchema: {
      recordingName: z
        .string()
        .describe(
          'Identifier for this recording. Pass the same name to reticle_record_stop and reticle_replay.',
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
    name: ReticleTool.RECORD_STOP,
    description:
      'Stop the recording identified by `recordingName` and return both the reaction report for the span and a compiled, replayable { program: { version, steps:[{tool,args,stable}] } } of the agent acts captured during it.',
    inputSchema: {
      recordingName: z
        .string()
        .describe('Identifier of an active recording started with reticle_record_start.'),
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
    name: ReticleTool.REPLAY,
    description:
      'Re-execute a previously recorded program by recordingName. Re-resolves each step to its element by testid (falling back to the stored ref for unstable steps) and runs the actions in order against the live session. Stops at the first failure. Destructive controls require confirmDangerous:true on every replay; confirmation is never persisted. Returns { ok, steps:[{tool,ok,error?,note?}] }.',
    inputSchema: {
      recordingName: z
        .string()
        .describe('Name of a compiled recording (from reticle_record_stop) to re-execute.'),
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
    name: ReticleTool.NARRATE,
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
      const result = (await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.NARRATE,
        {
          text: args['text'],
          level: args['level'],
        },
      )) as Record<string, unknown>;
      return { ok: true, ...result };
    },
  },
  {
    name: ReticleTool.CLOCK,
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
      commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.CLOCK, {
        freeze: args['freeze'],
        advanceMs: args['advanceMs'],
        reset: args['reset'],
      }),
  },
  {
    name: ReticleTool.STATE,
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
        ReticleCommand.STATE_READ,
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
    name: ReticleTool.EXPLORE,
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
      const result = await session.command(ReticleCommand.SNAPSHOT, {
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

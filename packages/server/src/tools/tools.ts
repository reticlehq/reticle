import { z } from 'zod';
import { IrisCommand, SnapshotMode } from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { withSizeCost } from '../session/output-budget.js';
import { applySnapshotDelta, SnapshotCache } from './snapshot-delta.js';
import { asString, asNumber } from './tools-helpers.js';
import { paginateQueryResult } from './query-paginate.js';
import { CONTRACT_TOOLS } from './contract-tools.js';
import { DOMAIN_TOOLS } from '../domain/domain-tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import { FLOW_TOOLS } from '../flows/flow-tools.js';
import { PROJECT_TOOLS } from '../project/project-tools.js';
import { VISUAL_TOOLS } from '../visual/visual-tools.js';
import { CRAWL_TOOLS } from '../crawl/crawl-tools.js';
import { SCROLL_TOOLS } from '../input/scroll-tools.js';
import { NETWORK_MOCK_TOOLS } from '../input/network-mock-tools.js';
import { SESSION_TOOLS } from '../session/session-tools.js';
import { ANNOTATE_TOOLS } from '../flows/annotate-tools.js';
import { LIVE_CONTROL_TOOLS } from '../session/live-control-tools.js';
import { UPDATE_TOOLS } from '../update/update-tools.js';
import { type ToolDef, sessionIdShape, commandOrThrow } from './tool-kit.js';
import { ACT_TOOLS } from './act-tools.js';
import { OBSERVE_TOOLS } from './observe-tools.js';
import { READ_TOOLS } from './read-tools.js';

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
  // iris_capabilities (live | fromDisk) + iris_contract_save. See contract-tools.ts.
  ...CONTRACT_TOOLS,
  ...DOMAIN_TOOLS,
  // iris_flow_save / iris_flow_list / iris_flow_load. See flow-tools.ts.
  ...FLOW_TOOLS,
  // iris_project (read history + diff-vs-last) / iris_run_record. See project-tools.ts.
  ...PROJECT_TOOLS,
  // iris_screenshot / iris_visual_diff — opt-in, CDP-driven. See visual-tools.ts.
  ...VISUAL_TOOLS,
  ...NETWORK_MOCK_TOOLS,
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
  ...OBSERVE_TOOLS,
  ...READ_TOOLS,
];

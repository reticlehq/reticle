import { z } from 'zod';
import {
  DiscoveryInvite,
  AttrNamesSchema,
  EventType,
  NoSessionAction,
  QueryBy,
  ReticleCommand,
  SnapshotMode,
} from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { withSizeCost } from '@/portal/session/output-budget.js';
import { applySnapshotDelta, SnapshotCache } from './read/snapshot-delta.js';
import { asNumber, asRecord, asString } from '@reticlehq/core';
import { countSchema } from './args/numeric-bounds.js';
import { normalizeQueryArgs } from './read/query-shape.js';
import { shapeQueryResult } from './read/query-windowed.js';

/**
 * The query strategies, derived from the enum in core — never retyped.
 *
 * The description used to hand-list them and had already drifted: it named six and omitted
 * `component`, which is real and works. Deriving both the schema and the prose from one source is
 * the repo's own rule, and here it is also the difference between refusing `by:'css'` and silently
 * answering "0 matches" to it.
 */
const QUERY_BY_VALUES = Object.values(QueryBy);
const QUERY_BY_LIST = QUERY_BY_VALUES.join(' | ');

/** Every `by`/`value` shorthand says the same thing; the parameter name carries the rest. */
const QUERY_ALIAS = 'Predicate spelling of by/value.';
const queryByEnum = z.enum(QUERY_BY_VALUES as [string, ...string[]]);
import { CONTRACT_TOOLS } from './contract-tools.js';
import { DOMAIN_TOOLS } from '@/judgement/domain/domain-tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import { FLOW_TOOLS } from '@/language/flows/flow-tools.js';
import { INTENT_TOOLS } from '@/memory/intent/intent-tools.js';
import { CONTEXT_TOOLS } from '@/judgement/runs/context-tools.js';
import { PROJECT_TOOLS } from '@/memory/project/project-tools.js';
import { MEMORY_TOOLS } from '@/memory/recall/memory-tools.js';
import { RUN_TOOLS } from '@/judgement/runs/run-tools.js';
import { VISUAL_TOOLS } from '@/features/visual/visual-tools.js';
import { AFFECTED_TOOLS } from '@/language/flows/affected-tools.js';
import { buildCoverageTools } from './coverage-tools.js';
import { VERIFY_CHANGE_TOOLS } from '@/language/flows/verify-change-tools.js';
import { CRAWL_TOOLS } from '@/features/crawl/crawl-tools.js';
import { EXPLORE_TOOLS } from './explore-tools.js';
import { SCROLL_TOOLS } from '@/portal/input/scroll-tools.js';
import { NETWORK_MOCK_TOOLS } from '@/portal/input/network-mock-tools.js';
import { VIEWPORT_TOOLS } from '@/portal/input/viewport-tools.js';
import { SESSION_TOOLS } from '@/portal/session/session-tools.js';
import { ANNOTATE_TOOLS } from '@/language/flows/annotate-tools.js';
import { LIVE_CONTROL_TOOLS } from '@/portal/session/live-control-tools.js';
import { type ToolDef, sessionIdShape, commandOrThrow } from './tool-kit.js';
import { TOOL_SURFACE, type ToolSurface } from './tool-surface.js';
import { mergeActWithSequence } from './act-merged.js';
import { INSPECT_TOOL } from './inspect-tool.js';
import { applyMerges, type MergePlan } from './merge-tools.js';
import { ACT_TOOLS } from './act-tools.js';
import { ACT_SEQUENCE_TOOL } from './act-sequence-tool.js';
import { OBSERVE_TOOLS } from './observe-tools.js';
import { LINEAGE_TOOLS } from './lineage-tools.js';
import { RECONCILE_TOOLS } from './reconcile-tools.js';
import { READ_TOOLS } from './read-tools.js';
import { LEASE_TOOLS } from './lease-tools.js';
import { FEEDBACK_TOOLS } from './feedback-tools.js';

// Re-exported so tool modules that import these from './tools.js' keep working after the kit move.
export type { ToolDef, ToolDeps } from './tool-kit.js';

/** FALLBACK for `diff: true`; the real one is per MCP client on `deps.snapshots`, which says why. */
const SNAPSHOT_CACHE = new SnapshotCache();

/** Every handler, including tools retired from the advertised MCP surface. */
export const RAW_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SESSIONS,
    description:
      'List connected browser sessions (tab url/title, sessionId, last-seen, health: hidden/focused/throttled, and `realInputAvailable` — true when native CDP/launched real input is driving this tab), plus a `recommendation` naming the in-protocol escape hatch (`reticle_run { tool: "reticle_lease" }`, with `reticle drive` as the human-side equivalent) when a tab is hidden/throttled and may be un-scriptable from here.',
    inputSchema: {},
    outputSchema: {
      sessions: z
        .array(
          // Keep in sync with SessionInfo (session.ts) plus the handler-added realInputAvailable/leased.
          // A strict MCP client validates this against the payload, so an undeclared field is a hard error.
          z.object({
            sessionId: z.string(),
            url: z.string(),
            projectId: z.string().optional(),
            title: z.string().optional(),
            adapters: z.array(z.string()),
            hasCapabilities: z.boolean(),
            runtime: z
              .string()
              .optional()
              .describe(
                "Which shell answered: web, electron or tauri. Absent on an SDK too old to report one — never defaulted, because a browser tab and a desktop window on the same url are otherwise indistinguishable and only one of them has the app's IPC.",
              ),
            versionSkew: z
              .string()
              .optional()
              .describe(
                "Present only when this page's SDK version differs from the daemon's. A skewed pair connects and then disagrees about tool behaviour — usually surfacing as a bare -32000. Fix it before trusting any verdict from this session.",
              ),
            lastSeenMs: z.number(),
            throttled: z.boolean(),
            focused: z.boolean(),
            hidden: z.boolean(),
            realInputAvailable: z.boolean().optional(),
            leased: z.boolean().optional(),
            stale: z.boolean().optional(),
            cleanup_suggestion: z.string().optional(),
            unresponsive: z
              .literal(true)
              .optional()
              .describe(
                'Present only when this tab is attached but has stopped answering commands: every call against it will time out. The other health fields still look fine, which is what makes this state invisible without the flag.',
              ),
            unresponsive_suggestion: z.string().optional(),
            pendingMarks: z.number().optional(),
            review_suggestion: z.string().optional(),
            recommendation: z.string().optional(),
            // Attached by SessionManager.list() (#117): whether this tab ever dropped and came back,
            // how often, and how long the last drop lasted. Undeclared here, a validating client
            // stripped the outage history while the row still looked complete — a verdict over a
            // window with a four-second blind gap read as trustworthy.
            attachment: z
              .object({
                connectedSinceMs: z.number(),
                outages: z.number(),
                lastOutage: z.object({ startedMs: z.number(), durationMs: z.number() }).optional(),
              })
              .optional()
              .describe(
                'Continuity of the SDK-to-daemon LINK for this tab, present for any tab the daemon has a record of: how long this attachment has lasted, how many times it dropped and came back, and when the last gap started and how long it lasted. `outages > 0` means a verdict over this window spans a gap where nothing was observed. These are link counters, NOT app health: they say nothing about whether the page origin is still serving, so a tab whose dev server has died reports `outages: 0` with a growing `connectedSinceMs` and is not evidence the app is up.',
              ),
          }),
        )
        .describe(
          'Connected browser sessions with health state. `projectId` groups sessions by app (stable across port changes); `leased` marks a pool-managed headless context vs a human tab.',
        ),
      why: z
        .string()
        .optional()
        .describe(
          'Present ONLY when `sessions` is empty: why nothing is connected, and the next action that fixes it. An empty list is never the end of the road — read this before concluding the app cannot be driven.',
        ),
      next_action: z
        .object({
          action: z.nativeEnum(NoSessionAction),
          command: z.string().optional(),
          port: z.number().optional(),
          reason: z.string(),
        })
        .optional()
        .describe(
          "Present ONLY when `sessions` is empty: the same answer as `why`, executable. `command` is the LITERAL command to run, sourced from this project's own package.json scripts and lockfile — it is absent, never guessed, when the project declares no dev script. `action` is one of daemon_split | start_dev_server | run_init | open_app | reopen_app. `daemon_split` outranks the rest and means the app IS running and instrumented, on a DIFFERENT daemon than the one you are attached to — do not start or re-init anything, read `reason`.",
        ),
      talk_to_us: z
        .string()
        .optional()
        .describe(
          'Present ONLY when `sessions` is empty: a call with the founder for the person you are working with. Offer it; never act on it.',
        ),
      lastKnown: z
        .object({
          sessionId: z.string(),
          url: z.string(),
        })
        .optional()
        .describe(
          'Present ONLY when `sessions` is empty AND a tab was connected to this daemon earlier: the last sessionId and URL that tab was on when it disappeared. A route that 500s tears the page down and the SDK never reconnects — this is the last thing we knew, not a route-500 verdict. An empty list with no lastKnown is a tab that never arrived.',
        ),
    },
    handler: async (deps) => {
      const provider = deps.realInput;
      const leasedIds = new Set(deps.pool?.leasedSessionIds() ?? []);
      const sessions = await Promise.all(
        deps.sessions.list().map(async (s) => ({
          ...s,
          realInputAvailable: provider !== undefined ? await provider.isAvailableFor(s.url) : false,
          leased: leasedIds.has(s.sessionId),
        })),
      );
      // An empty list is the most common thing this tool ever returns, and on its own it is a dead
      // end: the agent asked the one question it knows to ask, got a confident-looking answer with
      // no next step, and stopped. The daemon already knows WHY nothing is connected — say it here
      // rather than only when a later tool fails for want of a session.
      if (0 === sessions.length) {
        const why = deps.sessions.noSessionHint();
        // The executable half. `why` is for the human reading the transcript; this is the one the
        // agent acts on, so it never has to parse a paragraph to find a command inside it.
        const next = deps.sessions.noSessionNextAction();
        // The last tab, when one was here. Optional-call: test stubs of SessionManager predate it.
        const known = deps.sessions.lastKnown?.();
        const lastKnown = undefined === known ? undefined : { sessionId: known.id, url: known.url };
        return {
          sessions,
          ...(why === undefined ? {} : { why }),
          ...(next === undefined ? {} : { next_action: next }),
          ...(undefined === lastKnown ? {} : { lastKnown }),
          // Setup that never connects is where most people give up; it is the talk worth having.
          talk_to_us: DiscoveryInvite.AGENT,
        };
      }
      return { sessions };
    },
  },
  {
    name: ReticleTool.SNAPSHOT,
    example: { diff: true },
    description:
      'Semantic accessibility snapshot of the page or a subtree — `mode:"interactive"` returns only the controls, ~3x smaller. Refs (`e42`) are stable: the same element keeps its ref across snapshots and only stops resolving once it leaves the DOM — re-snapshot after a navigation or if a ref fails to resolve, not between ordinary actions. mode: full|interactive|status. Use to see what is on screen right now. The result carries cost:{ bytes, tokens } (estimated) — if it is large, re-scope (pass `scope`) or use mode:interactive/status instead of reading the whole tree. Pass diff:true after your first snapshot to get back ONLY what changed since your last look (mode:delta with added/removed, or mode:unchanged) — far fewer tokens and no stale tree to mis-read; a route change resets it to a full snapshot automatically.',
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
      status: z
        .object({
          route: z.string(),
          title: z.string().optional(),
          visibleDialogs: z.array(z.string()).optional(),
          overlayHidingPage: z.string().optional(),
        })
        .optional(),
      mode: z
        .string()
        .optional()
        .describe('full | delta | unchanged — which kind of diff response this is.'),
      delta: z
        .object({
          added: z.array(z.string()),
          removed: z.array(z.string()),
          addedCount: z.number(),
          removedCount: z.number(),
        })
        .optional()
        .describe('Only present on a diff:true call that found changes.'),
      changed: z
        .array(z.string())
        .optional()
        .describe(
          'Elements whose value changed in place (same ref, different content) — not a structural add/remove.',
        ),
      changedCount: z.number().optional().describe('Number of elements in `changed`.'),
      reason: z
        .string()
        .optional()
        .describe('Why mode is "full": first snapshot for this route, or route changed.'),
      cost: z
        .object({ bytes: z.number(), tokens: z.number() })
        .optional()
        .describe('Estimated size of this result — re-scope if large.'),
      // buildSnapshot has always returned these; leaving them undeclared stripped them from
      // structuredContent, so a schema-aware client saw a tree that ended abruptly with no way to
      // tell a small page from a capped one. Every "that element isn't rendered" conclusion drawn
      // from a capped tree inherits the omission.
      nodes: z.number().optional().describe('How many nodes this tree actually contains.'),
      truncated: z
        .boolean()
        .optional()
        .describe(
          'True when the page exceeded the snapshot cap. The tree is then a document-order PREFIX: an element being absent from it does NOT mean it is absent from the page.',
        ),
      note: z
        .string()
        .optional()
        .describe(
          'Why this result is not what it looks like. Four causes, all of which otherwise read as "the page is empty": a diff computed over a capped tree ("unchanged" is then partial); an interactive-mode tree emptied by leanness; a page whose elements all computed hidden; and an UNMOUNTED app, where the DOM under the scope holds almost nothing — that last one will not improve by waiting, so read reticle_console for an uncaught error instead.',
        ),
      scopeMissing: z
        .boolean()
        .optional()
        .describe(
          'True when a scope was given but resolved to nothing — the tree is EMPTY on purpose, not because the page is empty. Do not read an absent element as absent from the page; re-check the scope.',
        ),
      growthWarning: z
        .string()
        .optional()
        .describe(
          'Present when this same scope was smaller moments ago — content likely arrived after your last look, and a presence/absence conclusion drawn from that earlier snapshot may have been taken mid-load. Re-check rather than trusting the earlier read.',
        ),
    },
    // async so a synchronous resolve() failure (no session connected) surfaces as a REJECTED promise —
    // the handler contract every caller relies on — not a throw that escapes a direct invocation.
    handler: async (deps, args) => {
      // Resolve ONCE and key the diff cache on the RESOLVED session id. Keying on `sessionId ?? 'default'`
      // meant two different auto-selected sessions (agent omits sessionId) shared the 'default' slot, so
      // diff:true computed a delta against the WRONG session's prior snapshot — a cross-session false
      // change. Pass the resolved id to the command too, so the cache key and the snapshotted session
      // can't drift apart via a second auto-selection.
      const resolved = deps.sessions.resolve(asString(args['sessionId']));
      const mode = asString(args['mode']) ?? SnapshotMode.FULL;
      return commandOrThrow(deps, resolved.id, ReticleCommand.SNAPSHOT, {
        scope: args['scope'],
        mode,
      }).then((raw) =>
        withSizeCost(
          noteUnmountedRoot(
            noteHiddenPage(
              noteEmptyLeanTree(
                applySnapshotDelta(
                  raw,
                  {
                    sessionId: resolved.id,
                    scope: asString(args['scope']) ?? '',
                    mode,
                    diff: true === args['diff'],
                  },
                  deps.snapshots ?? SNAPSHOT_CACHE,
                ),
                mode,
              ),
              mode,
            ),
            mode,
            resolved,
          ),
        ),
      );
    },
  },
  {
    name: ReticleTool.QUERY,
    example: { by: 'testid', value: 'todo-list' },
    description: `Find elements by Testing-Library semantics, INCLUDING open shadow roots — \`count_only:true\` gives just the count (~30x smaller); \`limit\` caps descriptors. Pass \`by\` (${QUERY_BY_LIST}) and \`value\` (the query string). Returns matching refs + descriptors + visibility. Pass \`attrs:["href"]\` to project attributes (link/image URLs) onto each match. Pass \`limit\` to cap descriptors (broad role queries can be large) or \`count_only:true\` for just the match count — both cut tokens. On zero matches, also returns hint:{ route, presentRegions[], knownEmptyState, nameNearMiss[] } so you can distinguish an empty state from a missing element WITHOUT taking a snapshot — nameNearMiss carries the labels that role really has when an exact role+name query just missed. ASKING SEVERAL QUESTIONS ABOUT THE PAGE? One reticle_snapshot answers them all at once — a run of queries costs a round trip each and returns what the snapshot already held.`,
    inputSchema: {
      // Constrained to the enum, NOT z.string(). A free string let `by:'css'` through to the
      // browser's `default: return []`, so an unsupported strategy answered "0 matches" — which
      // reads as "the element is not on the page". Measured on a live page: by:'css' value:'body'
      // returned count 0. A false negative is the one answer this product must never invent.
      by: queryByEnum.optional().describe('Query strategy.'),
      value: z
        .string()
        .optional()
        .describe(
          'Query value for the selected strategy (e.g. by=role value=button, or by=testid value=submit-btn). Or use the predicate spelling directly: { testid: "submit" }, { text: "Deploy" }.',
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
      self: z
        .boolean()
        .optional()
        .describe(
          'Return the `scope` element ITSELF instead of searching inside it. Use when the target is a plain layout container with no role, name, testid or text of its own — which is routinely the element that carries the handler, and is otherwise unreachable because every query excludes its own scope root. Requires `scope`.',
        ),
      attrs: AttrNamesSchema.optional().describe(
        "Attribute NAMES to return per match, e.g. ['href'] for links, ['src'] for images. Projects, never filters: 'name=value' is refused. Absent omitted; credentials redacted.",
      ),
      limit: countSchema
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
      // The predicate's spelling, accepted as an alias for by/value so the shape an agent learns from
      // act_and_wait/assert also works here. See query-shape.ts.
      // Six copies of one sentence, re-sent every turn. The parameter NAME already says which
      // strategy it selects, and they sit in a block together, so each only has to say it is the
      // predicate spelling of by/value.
      testid: z.string().optional().describe(QUERY_ALIAS),
      text: z.string().optional().describe(QUERY_ALIAS),
      role: z.string().optional().describe(QUERY_ALIAS),
      label: z.string().optional().describe(QUERY_ALIAS),
      placeholder: z.string().optional().describe(QUERY_ALIAS),
      alt: z.string().optional().describe(QUERY_ALIAS),
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
            attrs: z
              .record(z.string())
              .optional()
              .describe(
                'Present only for attributes requested via `attrs` and found on the element.',
              ),
            source: z
              .string()
              .optional()
              .describe(
                'Where this element is written, as `file:line` — open this to change it. Present when the app is built with the Reticle plugin in dev; absent in production builds.',
              ),
            chart: z
              .array(
                z.object({
                  kind: z.string(),
                  tag: z.string(),
                  attr: z.string(),
                  sample: z.string(),
                }),
              )
              .optional()
              .describe(
                'Chart geometry faults, present ONLY when the element is a broken chart. kind is non-finite-coordinates | empty-geometry | degenerate-geometry. A healthy chart omits this. Declared here so structuredContent carries it on validating profiles rather than dropping it.',
              ),
          }),
        )
        .optional(),
      count: z
        .number()
        .optional()
        .describe(
          'How many elements MATCHED — always exact, even when the returned list was capped. Never derive a count from elements.length.',
        ),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` truncation — present only when truncated.'),
      truncated: z.boolean().optional().describe('True when `limit` dropped some matches.'),
      hint: z
        .object({
          route: z.string(),
          // The browser emits presentRegions and it was NOT declared here, so zod stripped it from
          // structuredContent on every zero-match result — the successor field was invisible while its
          // deprecated predecessor was the only thing an agent could see. An undeclared field is a
          // silent data loss, which is exactly what this schema exists to prevent.
          presentRegions: z
            .array(
              z.object({
                role: z.string(),
                name: z.string().optional(),
                childCount: z.number(),
                // `sample` is the orientation payload an agent actually reads ("there is a list with
                // 847 rows, first three are …"). It was omitted from the first version of this
                // declaration, which repeated the original sin one level down.
                sample: z.array(z.string()),
              }),
            )
            .optional()
            .describe('Structural clusters on the page — what IS here, to diagnose the miss.'),
          presentTestids: z.array(z.string()).optional(),
          // Declared for the same reason presentRegions had to be: undeclared here, it is stripped
          // from structuredContent without a word — and this field exists precisely to say a word.
          presentTestidsTotal: z
            .number()
            .optional()
            .describe(
              'Present only when presentTestids was cut at its cap: how many there were. The list is document order, so a region low on the page is what got dropped — absence from the list proves nothing.',
            ),
          knownEmptyState: z.boolean(),
          splitText: z
            .object({
              ref: z.string().optional(),
              role: z.string().optional(),
              name: z.string().optional(),
            })
            .passthrough()
            .optional()
            .describe(
              "Present when a TEXT search missed but the string IS on the page, split across this container's children. Retry as { scope: <ref>, self: true } — no text query can match a string no single element owns.",
            ),
          // Declared here for the same reason presentRegions had to be: the browser emits it, and an
          // undeclared field is stripped from structuredContent without a word.
          nameNearMiss: z
            .array(z.string())
            .optional()
            .describe(
              'Present when a ROLE+NAME search missed and that role DOES carry a nearly-matching name — role+name is exact, so "Mesh" does not find "2 Mesh". Retry with one of these spellings; no snapshot needed.',
            ),
        })
        .optional()
        .describe(
          'Present only on zero matches — tells you what IS on the page so you can diagnose the miss.',
        ),
      cost: z
        .object({ bytes: z.number(), tokens: z.number() })
        .optional()
        .describe('Estimated size of this result — narrow with `name`/`scope`/`limit` if large.'),
      scopeMissing: z
        .boolean()
        .optional()
        .describe(
          'True when a `scope` was given but resolved to nothing — zero matches then means the scope is gone, NOT that the element is absent. The search did not widen to the whole page. Re-check the scope before concluding anything.',
        ),
    },
    handler: (deps, rawArgs) => {
      // Accept the predicate's named-field spelling too — see query-shape.ts.
      const args = normalizeQueryArgs(rawArgs);
      return commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.QUERY, {
        by: args['by'],
        value: args['value'],
        name: args['name'],
        scope: args['scope'],
        // The handler forwards an explicit allowlist, so a new input is silently dropped unless it is
        // added here — the browser saw no `attrs` and returned undefined while the unit tests, which
        // call matchQuery directly, passed. Schema plus implementation is not the whole wire.
        //
        // It happened again with `self`, in the same session that wrote this comment: declared on the
        // tool, implemented in the browser, verified by unit tests that call `runQuery` directly, and
        // dropped here — so the live call returned zero matches with no error. `query-forwarding.test.ts`
        // now asserts the payload, because a comment is not a guard.
        attrs: args['attrs'],
        self: args['self'],
      }).then((result) => withSizeCost(shapeQueryResult(result, args)));
    },
  },
  // reticle_inspect: one element in full detail. See inspect-tool.ts.
  INSPECT_TOOL,
  // reticle_capabilities (live | fromDisk) + reticle_contract_save. See contract-tools.ts.
  ...RECONCILE_TOOLS,
  ...CONTRACT_TOOLS,
  ...INTENT_TOOLS,
  ...CONTEXT_TOOLS,
  ...DOMAIN_TOOLS,
  // reticle_flow_save / reticle_flow_list / reticle_flow_load. See flow-tools.ts.
  ...FLOW_TOOLS,
  // reticle_project (read history + diff-vs-last) / reticle_run_record. See project-tools.ts.
  ...PROJECT_TOOLS,
  ...MEMORY_TOOLS,
  // reticle_run_export — export the verification-run verdict artifact (.reticle/runs/). See run-tools.ts.
  ...RUN_TOOLS,
  // reticle_screenshot / reticle_visual_diff — opt-in, CDP-driven. See visual-tools.ts.
  ...VISUAL_TOOLS,
  ...NETWORK_MOCK_TOOLS,
  ...VIEWPORT_TOOLS,
  // reticle_crawl — autonomous click-everything + anomaly report. See crawl-tools.ts.
  ...CRAWL_TOOLS,
  ...EXPLORE_TOOLS,
  // reticle_scroll_to — reveal a virtualized off-screen row. See scroll-tools.ts.
  ...SCROLL_TOOLS,
  // Session lifecycle: reticle_session — tune the presenter session (idle-end). See session-tools.ts.
  ...SESSION_TOOLS,
  // reticle_annotate (structured annotation → expect/dynamic/success). See annotate-tools.ts.
  ...ANNOTATE_TOOLS,
  // reticle_affected — which saved flows a diff invalidates. Unadvertised (zero per-turn cost),
  // reachable through reticle_run. See affected-tools.ts.
  ...AFFECTED_TOOLS,
  // reticle_coverage — which controls were driven vs never touched. Unadvertised; via reticle_run.
  // The table is passed as a thunk so the coverage tool can report which of it was called without
  // importing it back — see buildCoverageTools. Called from the handler, long after TOOLS exists.
  ...buildCoverageTools(() => TOOLS.map((t) => t.name)),
  // reticle_verify_change — "did my change break anything" in one call. See verify-change-tools.ts.
  ...VERIFY_CHANGE_TOOLS,
  // Live-control: reticle_end_session / reticle_resume / reticle_messages. See live-control-tools.ts.
  ...LIVE_CONTROL_TOOLS,
  // reticle_navigate / reticle_refresh — browser navigation tools. See browser-tools.ts.
  ...BROWSER_TOOLS,
  ...ACT_TOOLS,
  ACT_SEQUENCE_TOOL,
  ...OBSERVE_TOOLS,
  ...LINEAGE_TOOLS,
  ...READ_TOOLS,
  ...LEASE_TOOLS,
  // reticle_feedback — the agent reports that RETICLE failed (not that the app did). See feedback-tools.ts.
  ...FEEDBACK_TOOLS,
];

/**
 * surface consolidation. Tool defs are re-sent EVERY turn, so the advertised count is a per-turn
 * tax multiplied by loop length. Sibling families collapse into one action-dispatched tool; the member
 * handlers stay defined above and are simply no longer advertised separately.
 *
 * Guardrail (from the plan): the 12-tool core hot-set keeps its EXACT names and shapes and is never
 * merged — sessions/navigate/snapshot/query/act/act_and_wait/observe/network/console/wait_for/assert/state.
 */
export const MERGE_PLANS: MergePlan[] = [
  {
    name: ReticleTool.BASELINE,
    description:
      'Semantic-state baselines: { action: "save" } snapshots the current state under a name, "list" returns saved names, "diff" compares the live page against a saved baseline (REMOVED/ADDED elements + console-error count).',
    members: {
      save: ReticleTool.BASELINE_SAVE,
      list: ReticleTool.BASELINE_LIST,
      diff: ReticleTool.DIFF,
    },
  },
  {
    name: ReticleTool.RECORD,
    description:
      'Timeline recording: { action: "start" } begins recording under a name, "stop" ends it and returns the reaction report plus a compiled replayable program.',
    members: { start: ReticleTool.RECORD_START, stop: ReticleTool.RECORD_STOP },
  },
  {
    name: ReticleTool.FLOW,
    description:
      'Saved-flow management: { action: "list" } names every saved flow, "load" reads+validates one by flowName, "delete" removes one. The hot verbs (flow_save, flow_replay, flow_heal) stay separate; whole-suite replay is reticle_verify { action: "flows" }.',
    members: {
      list: ReticleTool.FLOW_LIST,
      load: ReticleTool.FLOW_LOAD,
      delete: ReticleTool.FLOW_DELETE,
    },
  },
  {
    name: ReticleTool.SESSION,
    description:
      // `yield` leads, and that is not a style choice. A catalogue prints ONE line per tool, so
      // whatever comes first is what an agent discovers; when this sentence opened with `tune` the
      // MANDATORY handback sat past the cut and no agent reading the catalogue ever learned it
      // existed. The rule is: if a tool has an obligation, the obligation goes first.
      'Session lifecycle and the human channel, by action: "yield" hands control back to the human and is MANDATORY before you stop driving (mode: waiting|ask, between turns); "tune" adjusts the presenter session (e.g. idle-end window); "end" terminates the session for good; "resume" clears a human pause; "messages" drains the human→agent inbox; "review" lists/resolves the mistakes a human pinned to elements; "narrate" states your intent on the presenter HUD.',
    members: {
      tune: ReticleTool.SESSION_TUNE,
      yield: ReticleTool.YIELD,
      end: ReticleTool.END_SESSION,
      resume: ReticleTool.RESUME,
      messages: ReticleTool.MESSAGES,
      review: ReticleTool.REVIEW,
      narrate: ReticleTool.NARRATE,
    },
    // The handback the lease block orders on every session — the one call an agent MUST make, so it
    // is the one that must not need a schema lookup first.
    example: { action: 'yield', mode: 'waiting' },
  },
  {
    name: ReticleTool.VERIFY,
    description:
      'What is proved, and what is not — by action. Start from a change: { action: "affected" } names which saved flows must re-verify for the files you edited (pass `files`, and/or `since` for a git ref), and "change" goes further and actually replays them, answering with one `verified` plus `because`. `unknown` there is the honest answer when NO saved flow covers the change: nothing ran, so nothing was proved, and it is never reported as green. Without a change to start from: "flows" replays every saved flow for one consolidated suite verdict (deterministic, no LLM per flow), and "coverage" lists the interactive controls you have and have NOT driven this session — an untouched list still holding the controls your change affects means you are not done. "crawl" is the no-script option: it drives every reachable control itself and reports single-channel faults (console errors, failed requests, dead controls) and CONTRADICTIONS, two channels disagreeing about the same click — the false greens a human cannot see, because a human watches the screen and the screen looks correct. "explore" is the one to reach for on a project with NO saved flows: a model inside the daemon drives the app for you — pass a `persona` and it completes that whole journey — and RECORDS what it drove, so the next run replays it with no model in the loop and none of the driving costs your context. "mutate" grades the FLOW rather than the app: it breaks the endpoint a saved flow declared it depends on and replays it, and a flow that stays GREEN through a broken subject is a click sequence, not a test. "heal" repairs a flow whose LOCATOR drifted (a renamed testid), re-asserting the saved consequence before it writes and refusing when that stops firing — it heals a locator, never an intent. DESTRUCTIVE: crawl and explore really click, and may navigate or mutate state; "mutate" really fails a request on a driven page, and always puts it back.',
    members: {
      change: ReticleTool.VERIFY_CHANGE,
      flows: ReticleTool.FLOW_VERIFY,
      affected: ReticleTool.AFFECTED,
      coverage: ReticleTool.COVERAGE,
      crawl: ReticleTool.CRAWL,
      explore: ReticleTool.VERIFY_EXPLORE,
      // Grades the FLOW rather than the app: break what the flow declared it depends on and see
      // whether it notices. An action rather than a nineteenth tool, because the surface is meant
      // to be shaped like the work.
      mutate: ReticleTool.FLOW_MUTATE,
      // The other half of the replay loop, and the half that was unreachable: heal is advertised by
      // no capped surface, and the nine-tool one has no dispatch hatch, so an agent could DETECT
      // drift and never repair it — one renamed testid and that journey is driven by hand forever.
      // An action rather than a tenth tool, and safe to fold in because heal only rebinds a LOCATOR:
      // it re-asserts the saved consequence before writing and refuses when that stops firing.
      heal: ReticleTool.FLOW_HEAL,
    },
    // No default action ON PURPOSE. The name implies no single member, and one of them really
    // clicks: a fallthrough that guessed wrong would drive the app rather than read it. Every action
    // is explicit, which for `crawl` is the whole safety story.
    example: { action: 'change', files: ['src/App.tsx'] },
  },
  {
    name: ReticleTool.LEASE,
    description:
      'Isolated headless contexts from the shared pool: { action: "acquire" } leases one and navigates it to the app URL, "release" closes it and frees the slot.',
    members: { acquire: ReticleTool.LEASE_ACQUIRE, release: ReticleTool.LEASE_RELEASE },
  },
];

/**
 * Retired from the MCP surface entirely (capability preserved elsewhere, per the plan):
 * - run_record: auto-recording on flow_replay already persists run outcomes.
 */
export const RETIRED_FROM_SURFACE: string[] = [
  ReticleTool.RUN_RECORD, // auto-recording on flow_replay already persists run outcomes
  ReticleTool.REFRESH, // absorbed into reticle_navigate { reload: true }
  ReticleTool.WAIT_READY, // server-internal: the first live call already blocks for the session
];

/**
 * An empty `interactive` tree is a claim, and it is usually the wrong one.
 *
 * `mode:"interactive"` filters on ARIA role, and a large share of production UI carries none. On
 * MarkText — a shipped Electron editor — it returns NOTHING while `mode:"full"` returns 47 nodes,
 * because its whole block picker is `<div>`s with no role, no testid and no pointer cursor. This
 * tool's own description recommends the lean mode, so an agent takes the cheap look, is handed `""`,
 * and reads it as an empty page. It is the one shape of answer this product must never invent.
 *
 * The browser counts what leanness passed over, so the tool can say which of the two it is.
 */
function noteEmptyLeanTree(result: unknown, mode: string): unknown {
  if (SnapshotMode.INTERACTIVE !== mode) return result;
  const row = asRecord(result);
  if (0 !== asNumber(row['nodes'])) return result;
  const skipped = asNumber(row['leanSkipped']) ?? 0;
  if (0 === skipped) return result;
  return {
    ...row,
    note:
      `no element on this page carries an interactive ARIA role, so this mode found nothing — ` +
      `${String(skipped)} element(s) were passed over for leanness and this is NOT an empty page. ` +
      `Take reticle_snapshot { mode: "full" } instead; the controls here are addressed by text or ` +
      `by testid rather than by role.`,
  };
}

/**
 * An empty tree on a page full of elements is the same claim, from the other cause.
 *
 * `noteEmptyLeanTree` covers leanness and returns early for every other mode, so a `full` snapshot
 * that comes back `{ tree: "", nodes: 0 }` says nothing at all — and that is the shape #672 was
 * reported as: 44 buttons and 12 textboxes on the page, every one computing hidden, both modes
 * empty. The reporter spent about six tool calls and a large console dump establishing the page was
 * fine and the snapshot was wrong, then drove the flow off `reticle_query` refs, which is a
 * workaround no tool description mentions.
 *
 * So the note names the count, says plainly that this is not an empty page, and hands over the path
 * that does work. It does NOT diagnose why the page is hidden: the walk knows what it skipped and
 * cannot know why, and a note that guessed would be the same kind of overconfident answer as the
 * empty tree it replaces.
 */
/**
 * How much DOM there is under the mount container, when the tree is empty and nothing was skipped.
 *
 * A handful of elements is a container with nothing in it. React's own root div counts as one, and a
 * wrapper or two is ordinary, so this is deliberately not `=== 0`.
 */
const UNMOUNTED_ROOT_MAX_ELEMENTS = 3;

/**
 * The third cause of an empty tree, and the one the walk cannot see: the app is not mounted.
 *
 * Reported from the field with the react-three-fiber crash. The source-mapping stamp threw inside
 * R3F's commit phase, React unmounted the entire tree, and the page went white — and the snapshot
 * answered `{ tree: "", nodes: 0 }`, which is also what a page that has not rendered yet answers.
 * The reporter spent a diagnosis pass separating the two, and said that detecting a dead root would
 * have pointed straight at the cause.
 *
 * The other two notes here explain an empty tree by what the WALK passed over. This one cannot: a
 * walk that visited nothing has nothing to have skipped. It reads the DOM count instead, which is
 * why the browser now reports it, and it fires only when the skip counts are silent — a page whose
 * elements were all hidden has plenty of DOM and belongs to `noteHiddenPage`.
 *
 * Like both of its neighbours it names a fact and hands over the next read, and does not diagnose:
 * "not mounted" is certain from the count, WHY is not, and the console is where the answer is.
 */
/**
 * The uncaught errors already in the session buffer, if there are any.
 *
 * An unmounted root has two readings that call for opposite next moves: an app that has not started
 * yet (load it), and an app that started and threw (read the error). The count above settles that it
 * is unmounted and cannot settle which — but the buffer beside it usually can, and the note used to
 * send the reader to `reticle_console` to fetch a fact the server was already holding. That round
 * trip is the whole of #899: the reporter took a screenshot, then read the console, and found five
 * `Uncaught Error` entries about fifteen tool calls after the crash.
 *
 * Read defensively off the resolved session rather than through a narrowed type: the snapshot
 * handler's only contract with `resolve()` is `id` and `command`, and a session that cannot answer
 * for its buffer must degrade to the old note rather than fail the snapshot.
 */
interface CrashEvidence {
  readonly count: number;
  readonly first: string;
}

function crashEvidence(session: unknown): CrashEvidence | undefined {
  const since = asRecord(session)['eventsSince'];
  if ('function' !== typeof since) return undefined;
  let events: unknown;
  try {
    events = (since as (cursor: number) => unknown).call(session, 0);
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  const errors = events.filter((e) => {
    const type = asString(asRecord(e)['type']);
    return EventType.CONSOLE_ERROR === type || EventType.ERROR_UNCAUGHT === type;
  });
  if (0 === errors.length) return undefined;
  const first = errors
    .map((e) => asString(asRecord(asRecord(e)['data'])['message']))
    .find((m): m is string => undefined !== m && '' !== m);
  return { count: errors.length, first: first ?? '' };
}

function noteUnmountedRoot(result: unknown, mode: string, session?: unknown): unknown {
  if (SnapshotMode.STATUS === mode) return result;
  const row = asRecord(result);
  if (0 !== asNumber(row['nodes'])) return result;
  if (row['note'] !== undefined) return result;
  const elements = asNumber(row['domElements']);
  if (elements === undefined || elements > UNMOUNTED_ROOT_MAX_ELEMENTS) return result;
  const mount =
    `the tree is empty because there is almost nothing in the DOM: ${String(elements)} ` +
    `element(s) under this scope. That is a mount container with nothing rendered into it, not a ` +
    `page whose contents were skipped — so the app is UNMOUNTED rather than slow, and waiting ` +
    `will not change it. `;
  // An uncaught error beside an empty mount container is the difference between "has not started"
  // and "started and died", which are the two readings of this count and want opposite next moves.
  // Nothing here is framework-specific, and deliberately so: the condition is a known mount
  // container that holds nothing with an uncaught error beside it, which is as true of a Vue or
  // Svelte root as a React one.
  const crash = crashEvidence(session);
  if (crash !== undefined) {
    return {
      ...row,
      note:
        mount +
        `The app did not merely fail to start — it CRASHED: ${String(crash.count)} uncaught ` +
        `error(s) were logged in this session` +
        ('' === crash.first ? '' : `, the first: "${crash.first}"`) +
        `. Read reticle_console for the rest, and check anything that runs inside a framework ` +
        `commit phase. Loading the app again will reproduce it rather than fix it.`,
    };
  }
  return {
    ...row,
    note:
      mount +
      `An app that was rendering and then stopped has usually thrown: read ` +
      `reticle_console for an uncaught error, and check anything that runs inside a framework ` +
      `commit phase. If the app has genuinely not started yet, load it and snapshot again.`,
  };
}

function noteHiddenPage(result: unknown, mode: string): unknown {
  if (SnapshotMode.STATUS === mode) return result;
  const row = asRecord(result);
  if (0 !== asNumber(row['nodes'])) return result;
  // A note already there is the more specific one (leanness), and two explanations for one empty
  // tree is worse than the better of them alone.
  if (row['note'] !== undefined) return result;
  const skipped = asNumber(row['hiddenSkipped']) ?? 0;
  if (0 === skipped) return result;
  return {
    ...row,
    note:
      `this is NOT an empty page: ${String(skipped)} subtree(s) were skipped because their root ` +
      `computed hidden (aria-hidden, the hidden attribute, or display:none), which is what left the ` +
      `tree empty. If the page is plainly rendered, the visibility computation is the thing that is ` +
      `wrong rather than the app — drive it by reticle_query refs, which do not depend on this walk.`,
  };
}

export const TOOLS: ToolDef[] = applyMerges(RAW_TOOLS, MERGE_PLANS, RETIRED_FROM_SURFACE);

/**
 * The consolidation that is still UNDER MEASUREMENT, and is not what anybody gets by default.
 *
 * `MERGE_PLANS` above collapses cold sibling families. These four go further and merge inside the
 * core hot-set, which the guardrail on `MERGE_PLANS` explicitly forbids — so they live on their own
 * surface (`TOOL_SURFACE.MERGED`) rather than changing the one every user sees. The rule this
 * follows is the one written on `TOOL_SURFACE.VERIFY`: that surface cut the bill 37% and TRIPLED
 * false alarms, so a token number alone never promotes a surface.
 *
 * MEASURED, on the wire, against the default surface as it is actually advertised (terse
 * descriptions, lean input shapes, no output schemas — measuring the raw ToolDefs instead reads 3x
 * too high and is the mistake that started this):
 *
 *   default   17 tools   21,873 B   ~5,468 tok
 *   merged    10 tools   17,885 B   ~4,471 tok   (-18.2%)
 *
 * NOT MEASURED: whether a model verifies as accurately against it. That is the number that decides
 * whether this ever becomes the default, and it needs the fix-and-verify benchmark with a key.
 *
 * `reticle_act` and `reticle_act_and_wait` stay separate ON PURPOSE, and not only because `act`
 * owns the `action` parameter (see `refuseDiscriminatorCollision`). They are the verdict boundary:
 * `act_and_wait` names the expected consequence BEFORE the action and returns a verdict, `act`
 * proves nothing. Merging them makes the proof an optional parameter instead of a different tool —
 * a forgotten tool name is an error, a forgotten parameter is a silent non-verdict, and a silent
 * non-verdict is the shape of the only false green this repository has ever measured.
 */
export const SURFACE_MERGE_PLANS: MergePlan[] = [
  {
    name: ReticleTool.LOOK,
    description:
      'Read the page, by action: "page" is the semantic snapshot of what is rendered, "find" resolves a locator (testid/role/text/component) to refs you can act on, "element" is the full detail of one ref, "state" reads the framework store. Reads only — nothing here changes the app.',
    members: {
      page: ReticleTool.SNAPSHOT,
      find: ReticleTool.QUERY,
      element: ReticleTool.INSPECT,
      state: ReticleTool.STATE,
    },
    example: { action: 'find', by: 'testid', value: 'submit' },
    // A bare `reticle_look` is "show me the page" — the move an agent makes before it knows enough
    // to ask anything narrower, and the one the unmerged surface answered with `reticle_snapshot`.
    defaultAction: 'page',
  },
  {
    name: ReticleTool.OBSERVE,
    description:
      'What the app DID, by action: "events" is the reaction window since a cursor, "network" the requests it made, "console" what it logged. Evidence, not a verdict — the four evidence tools are what the `verify` surface dropped when it tripled its false-alarm rate.',
    members: {
      events: ReticleTool.OBSERVE,
      network: ReticleTool.NETWORK,
      console: ReticleTool.CONSOLE,
    },
    example: { action: 'events' },
    // The reaction window is what "observe" means with no qualifier.
    defaultAction: 'events',
  },
  {
    name: ReticleTool.ASSERT,
    description:
      'Prove a consequence, by action: "now" evaluates a predicate against the window that already exists, "wait" waits for one to become true within a budget. Both return a verdict; only `verified:"yes"` is a pass.',
    members: { now: ReticleTool.ASSERT, wait: ReticleTool.WAIT_FOR },
    example: { action: 'now' },
    // Evaluate against the window that already exists. `wait` spends a budget, so it is asked for.
    defaultAction: 'now',
  },
];

/**
 * The `merged` surface's table. Built from the SAME raw tools and the same handlers — a merge can
 * change the advertised shape and nothing else, which is what makes the two surfaces comparable.
 */
/**
 * Every merge the `merged` surface applies, as ONE list.
 *
 * Named rather than inlined into `applyMerges`' argument because a second reader needs it:
 * `mergedNameRedirect` builds its tombstones from these plans. A member injected inline instead gets
 * no tombstone, and the merged name answers "not found" on the surface where it stopped existing —
 * which is what happened to `reticle_sessions`, the first call most agents make.
 */
export const MERGED_SURFACE_PLANS: MergePlan[] = [
  ...MERGE_PLANS.map((plan) =>
    plan.name === ReticleTool.SESSION
      ? {
          ...plan,
          // `list` and `feedback` join the session family HERE and not in MERGE_PLANS, so the
          // harness toolset — which builds from TOOLS — keeps excluding `reticle_feedback` by
          // name. A model driving in a loop reports its own confusion as a product defect.
          members: {
            ...plan.members,
            list: ReticleTool.SESSIONS,
            feedback: ReticleTool.FEEDBACK,
          },
          // A bare `reticle_session` is "what is connected?" — the FIRST call an agent makes, and
          // the one `reticle_sessions` answered before it was folded in here. Only on this
          // surface: on the default one `reticle_sessions` still exists and this tool is purely
          // lifecycle, where no member is the obvious bare meaning.
          defaultAction: 'list',
        }
      : plan,
  ),
  ...SURFACE_MERGE_PLANS,
];

const MERGED_BASE: ToolDef[] = applyMerges(RAW_TOOLS, MERGED_SURFACE_PLANS, RETIRED_FROM_SURFACE);

/**
 * The `merged` table: the plans above, plus the one merge the plan machinery cannot express.
 *
 * `act` absorbing `act_sequence` routes on shape, not on an `action` discriminator, because `act`
 * already owns that parameter name. See act-merged.ts.
 */
export const MERGED_TOOLS: ToolDef[] = (() => {
  const act = MERGED_BASE.find((tool) => tool.name === ReticleTool.ACT);
  const sequence = MERGED_BASE.find((tool) => tool.name === ReticleTool.ACT_SEQUENCE);
  if (act === undefined || sequence === undefined) {
    throw new Error('merged surface: act and act_sequence must both exist to be merged');
  }
  return [
    ...MERGED_BASE.filter(
      (tool) => tool.name !== ReticleTool.ACT && tool.name !== ReticleTool.ACT_SEQUENCE,
    ),
    mergeActWithSequence(act, sequence),
  ];
})();

/**
 * Which table a surface serves.
 *
 * `merged` is the one surface whose tools are not the shipped ones — it advertises the same
 * capabilities under merged names, so it needs the table those names exist in. Every other surface
 * is a FILTER over `TOOLS` and shares it.
 */
export function tableForSurface(surface: ToolSurface): readonly ToolDef[] {
  return surface === TOOL_SURFACE.MERGED ? MERGED_TOOLS : TOOLS;
}

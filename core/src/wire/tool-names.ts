import { FlowStepTool } from '../artifacts/flow-types.js';

/**
 * The names an agent calls Reticle by.
 *
 * Wire strings, and this package is where wire strings live: a name here crosses the boundary between
 * an agent and the daemon exactly as an event type crosses the one between the page and the bridge.
 * It sat under the server's tool directory because that is where the handlers are, and the result was
 * that every feature wanting to name a tool -- flows naming the steps it replays, crawl, runs -- had
 * to import from the tool surface to get at a string. Thirty-three of those imports were this one
 * table.
 *
 * MCP tool names exposed to the coding agent. No free strings. The three that appear in a persisted
 *  flow (ACT / ACT_SEQUENCE / ACT_AND_WAIT) come from core's FlowStepTool — one source shared with the
 *  browser recorder and the flow schema, so a rename can't desync the recorder from the replayer. */
export const ReticleTool = {
  SESSIONS: 'reticle_sessions',
  SNAPSHOT: 'reticle_snapshot',
  QUERY: 'reticle_query',
  INSPECT: 'reticle_inspect',
  ACT: FlowStepTool.ACT,
  ACT_SEQUENCE: FlowStepTool.ACT_SEQUENCE,
  ACT_AND_WAIT: FlowStepTool.ACT_AND_WAIT,
  OBSERVE: 'reticle_observe',
  LINEAGE: 'reticle_lineage',
  WAIT_FOR: 'reticle_wait_for',
  NETWORK: 'reticle_network',
  CONSOLE: 'reticle_console',
  ANIMATIONS: 'reticle_animations',
  ASSERT: 'reticle_assert',
  RECONCILE: 'reticle_reconcile',
  BASELINE_SAVE: 'reticle_baseline_save',
  BASELINE_LIST: 'reticle_baseline_list',
  DIFF: 'reticle_diff',
  RECORD_START: 'reticle_record_start',
  RECORD_STOP: 'reticle_record_stop',
  REPLAY: 'reticle_replay',
  EXPLORE: 'reticle_explore',
  NARRATE: 'reticle_narrate',
  CLOCK: 'reticle_clock',
  STATE: 'reticle_state',
  STORAGE: 'reticle_storage',
  CAPABILITIES: 'reticle_capabilities',
  CONTRACT_SAVE: 'reticle_contract_save',
  DOMAIN: 'reticle_domain',
  FLOW_SAVE: 'reticle_flow_save',
  FLOW_LIST: 'reticle_flow_list',
  FLOW_LOAD: 'reticle_flow_load',
  FLOW_DELETE: 'reticle_flow_delete',
  FLOW_REPLAY: 'reticle_flow_replay',
  /** replay EVERY saved flow → one consolidated suite verdict + prioritized fixes (the loop closer). */
  FLOW_VERIFY: 'reticle_flow_verify',
  /** persist the human-recorded flow from the live tab. */
  FLOW_SAVE_RECORDED: 'reticle_flow_save_recorded',
  /** propose (+ opt-in apply) a nearest-match rebind for a drifted flow. */
  FLOW_HEAL: 'reticle_flow_heal',
  /** Does this flow notice when the thing it depends on breaks? See flow-mutate-tools.ts. */
  FLOW_MUTATE: 'reticle_flow_mutate',
  /** structured annotation → compiles into the recording's expect/dynamic/success. */
  ANNOTATE: 'reticle_annotate',
  AFFECTED: 'reticle_affected',
  COVERAGE: 'reticle_coverage',
  VERIFY_CHANGE: 'reticle_verify_change',
  /** drive the app with a model and SAVE what it drove, for a project with nothing to replay yet. */
  VERIFY_EXPLORE: 'reticle_verify_explore',
  /** Merged: change/flows/affected/coverage/crawl — "what is proved, and what is not". */
  INTENT: 'reticle_intent',
  /** what THIS run has established, proved, and not yet discharged — pulled when memory is gone. */
  CONTEXT: 'reticle_context',
  VERIFY: 'reticle_verify',
  /** read cross-run history (.reticle/project.json) + diff-vs-last for a name. */
  PROJECT: 'reticle_project',
  /** The team's shared memory, read on demand — see memory/memory-tools.ts. */
  MEMORY: 'reticle_memory',
  /** explicitly record a run outcome (the manual companion to auto-recording). */
  RUN_RECORD: 'reticle_run_record',
  /** capture a pixel screenshot (CDP/driven browser) →.reticle/visual/<name>.png. */
  SCREENSHOT: 'reticle_screenshot',
  /** stub/intercept network on the driven page (500, offline, delay) for error/edge-state testing. */
  NETWORK_MOCK: 'reticle_network_mock',
  /** pin the driven page's viewport to fixed pixels for reproducible visual baselines. */
  VIEWPORT: 'reticle_viewport',
  /** perceptual-diff the live page against a saved visual baseline. */
  VISUAL_DIFF: 'reticle_visual_diff',
  /** autonomously click every reachable control + report anomalies (no script). */
  CRAWL: 'reticle_crawl',
  /** scroll a virtualized list until a queried row mounts, then return it. */
  SCROLL_TO: 'reticle_scroll_to',
  /** Session lifecycle: tune the presenter session (e.g. idle-end window) for the app's needs.
   * Member of the consolidated reticle_session {action:"tune"} — no longer advertised alone. */
  SESSION_TUNE: 'reticle_session_tune',
  /** Live-control: end the session (→ ended + push PRESENTER). Handlers live in the tools facet. */
  END_SESSION: 'reticle_end_session',
  /** Live-control: hand the session back to the human between turns (→ waiting/ask, revivable). */
  YIELD: 'reticle_yield',
  /** Live-control: clear a pause (→ active). */
  RESUME: 'reticle_resume',
  /** Live-control: drain the human→agent inbox (explicit poll). */
  MESSAGES: 'reticle_messages',
  /** Human review: list the mistakes the human pinned to elements, and resolve them once fixed. */
  REVIEW: 'reticle_review',
  /** First-run readiness: block briefly until the app's SDK connects (smooths the init→connect race). */
  WAIT_READY: 'reticle_wait_ready',
  /** Navigate the connected browser tab to a URL. */
  NAVIGATE: 'reticle_navigate',
  /** Reload the connected browser tab (soft or hard). */
  REFRESH: 'reticle_refresh',
  /** Export a verification-run artifact (.reticle/runs/<id>.json) — the OEM/CI-consumable verdict. */
  RUN_EXPORT: 'reticle_run_export',
  /** Consolidated families — one action-dispatched tool per family; members below stay
   * defined (handlers intact) but are no longer advertised separately. */
  BASELINE: 'reticle_baseline',
  SESSION: 'reticle_session',
  RECORD: 'reticle_record',
  FLOW: 'reticle_flow',
  LEASE: 'reticle_lease',
  /** Lease a fresh isolated headless context from the shared browser pool (one per flow). */
  LEASE_ACQUIRE: 'reticle_lease_acquire',
  /** Release a previously leased context, freeing the pool slot. */
  LEASE_RELEASE: 'reticle_lease_release',
  /** Meta: discover tool definitions on demand instead of paying for all of them every turn. */
  TOOLS: 'reticle_tools',
  /** Meta: invoke any tool by name — the escape hatch that keeps a trimmed profile a trim, not a removal. */
  RUN: 'reticle_run',
  /** Report that Reticle itself failed — the agent's only way to tell us what to fix. */
  FEEDBACK: 'reticle_feedback',
} as const;
export type ReticleTool = (typeof ReticleTool)[keyof typeof ReticleTool];

/** MCP tool names exposed to the coding agent (plan/05). No free strings. */
export const ReticleTool = {
  SESSIONS: 'reticle_sessions',
  SNAPSHOT: 'reticle_snapshot',
  QUERY: 'reticle_query',
  INSPECT: 'reticle_inspect',
  ACT: 'reticle_act',
  ACT_SEQUENCE: 'reticle_act_sequence',
  ACT_AND_WAIT: 'reticle_act_and_wait',
  OBSERVE: 'reticle_observe',
  WAIT_FOR: 'reticle_wait_for',
  NETWORK: 'reticle_network',
  CONSOLE: 'reticle_console',
  ANIMATIONS: 'reticle_animations',
  ASSERT: 'reticle_assert',
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
  CAPABILITIES: 'reticle_capabilities',
  CONTRACT_SAVE: 'reticle_contract_save',
  DOMAIN: 'reticle_domain',
  FLOW_SAVE: 'reticle_flow_save',
  FLOW_LIST: 'reticle_flow_list',
  FLOW_LOAD: 'reticle_flow_load',
  FLOW_REPLAY: 'reticle_flow_replay',
  /** replay EVERY saved flow → one consolidated suite verdict + prioritized fixes (the loop closer). */
  FLOW_VERIFY: 'reticle_flow_verify',
  /** persist the human-recorded flow from the live tab. */
  FLOW_SAVE_RECORDED: 'reticle_flow_save_recorded',
  /** propose (+ opt-in apply) a nearest-match rebind for a drifted flow. */
  FLOW_HEAL: 'reticle_flow_heal',
  /** structured annotation → compiles into the recording's expect/dynamic/success. */
  ANNOTATE: 'reticle_annotate',
  /** read cross-run history (.reticle/project.json) + diff-vs-last for a name. */
  PROJECT: 'reticle_project',
  /** explicitly record a run outcome (the manual companion to auto-recording). */
  RUN_RECORD: 'reticle_run_record',
  /** capture a pixel screenshot (CDP/driven browser) → .reticle/visual/<name>.png. */
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
  /** Session lifecycle: tune the presenter session (e.g. idle-end window) for the app's needs. */
  SESSION: 'reticle_session',
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
  /** Report running version, latest available, changelog, and breaking changes. */
  VERSION_INFO: 'reticle_version_info',
  /** Install the latest server version and restart (Claude Code reconnects automatically). */
  APPLY_UPDATE: 'reticle_apply_update',
  /** Restore the previous server version and restart. */
  ROLLBACK: 'reticle_rollback',
  /** Export a verification-run artifact (.reticle/runs/<id>.json) — the OEM/CI-consumable verdict. */
  RUN_EXPORT: 'reticle_run_export',
  /** Lease a fresh isolated headless context from the shared browser pool (one per flow). */
  LEASE_ACQUIRE: 'reticle_lease_acquire',
  /** Release a previously leased context, freeing the pool slot. */
  LEASE_RELEASE: 'reticle_lease_release',
} as const;
export type ReticleTool = (typeof ReticleTool)[keyof typeof ReticleTool];

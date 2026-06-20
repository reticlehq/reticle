/** MCP tool names exposed to the coding agent (plan/05). No free strings. */
export const IrisTool = {
  SESSIONS: 'iris_sessions',
  SNAPSHOT: 'iris_snapshot',
  QUERY: 'iris_query',
  INSPECT: 'iris_inspect',
  ACT: 'iris_act',
  ACT_SEQUENCE: 'iris_act_sequence',
  ACT_AND_WAIT: 'iris_act_and_wait',
  OBSERVE: 'iris_observe',
  WAIT_FOR: 'iris_wait_for',
  NETWORK: 'iris_network',
  CONSOLE: 'iris_console',
  ANIMATIONS: 'iris_animations',
  ASSERT: 'iris_assert',
  BASELINE_SAVE: 'iris_baseline_save',
  BASELINE_LIST: 'iris_baseline_list',
  DIFF: 'iris_diff',
  RECORD_START: 'iris_record_start',
  RECORD_STOP: 'iris_record_stop',
  REPLAY: 'iris_replay',
  EXPLORE: 'iris_explore',
  NARRATE: 'iris_narrate',
  CLOCK: 'iris_clock',
  STATE: 'iris_state',
  CAPABILITIES: 'iris_capabilities',
  CONTRACT_SAVE: 'iris_contract_save',
  DOMAIN: 'iris_domain',
  FLOW_SAVE: 'iris_flow_save',
  FLOW_LIST: 'iris_flow_list',
  FLOW_LOAD: 'iris_flow_load',
  FLOW_REPLAY: 'iris_flow_replay',
  /** replay EVERY saved flow → one consolidated suite verdict + prioritized fixes (the loop closer). */
  FLOW_VERIFY: 'iris_flow_verify',
  /** persist the human-recorded flow from the live tab. */
  FLOW_SAVE_RECORDED: 'iris_flow_save_recorded',
  /** propose (+ opt-in apply) a nearest-match rebind for a drifted flow. */
  FLOW_HEAL: 'iris_flow_heal',
  /** structured annotation → compiles into the recording's expect/dynamic/success. */
  ANNOTATE: 'iris_annotate',
  /** read cross-run history (.iris/project.json) + diff-vs-last for a name. */
  PROJECT: 'iris_project',
  /** explicitly record a run outcome (the manual companion to auto-recording). */
  RUN_RECORD: 'iris_run_record',
  /** capture a pixel screenshot (CDP/driven browser) → .iris/visual/<name>.png. */
  SCREENSHOT: 'iris_screenshot',
  /** stub/intercept network on the driven page (500, offline, delay) for error/edge-state testing. */
  NETWORK_MOCK: 'iris_network_mock',
  /** pin the driven page's viewport to fixed pixels for reproducible visual baselines. */
  VIEWPORT: 'iris_viewport',
  /** perceptual-diff the live page against a saved visual baseline. */
  VISUAL_DIFF: 'iris_visual_diff',
  /** autonomously click every reachable control + report anomalies (no script). */
  CRAWL: 'iris_crawl',
  /** scroll a virtualized list until a queried row mounts, then return it. */
  SCROLL_TO: 'iris_scroll_to',
  /** Session lifecycle: tune the presenter session (e.g. idle-end window) for the app's needs. */
  SESSION: 'iris_session',
  /** Live-control: end the session (→ ended + push PRESENTER). Handlers live in the tools facet. */
  END_SESSION: 'iris_end_session',
  /** Live-control: hand the session back to the human between turns (→ waiting/ask, revivable). */
  YIELD: 'iris_yield',
  /** Live-control: clear a pause (→ active). */
  RESUME: 'iris_resume',
  /** Live-control: drain the human→agent inbox (explicit poll). */
  MESSAGES: 'iris_messages',
  /** Human review: list the mistakes the human pinned to elements, and resolve them once fixed. */
  REVIEW: 'iris_review',
  /** First-run readiness: block briefly until the app's SDK connects (smooths the init→connect race). */
  WAIT_READY: 'iris_wait_ready',
  /** Navigate the connected browser tab to a URL. */
  NAVIGATE: 'iris_navigate',
  /** Reload the connected browser tab (soft or hard). */
  REFRESH: 'iris_refresh',
  /** Report running version, latest available, changelog, and breaking changes. */
  VERSION_INFO: 'iris_version_info',
  /** Install the latest server version and restart (Claude Code reconnects automatically). */
  APPLY_UPDATE: 'iris_apply_update',
  /** Restore the previous server version and restart. */
  ROLLBACK: 'iris_rollback',
  /** Export a verification-run artifact (.iris/runs/<id>.json) — the OEM/CI-consumable verdict. */
  RUN_EXPORT: 'iris_run_export',
} as const;
export type IrisTool = (typeof IrisTool)[keyof typeof IrisTool];

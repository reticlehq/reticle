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
  FLOW_SAVE: 'iris_flow_save',
  FLOW_LIST: 'iris_flow_list',
  FLOW_LOAD: 'iris_flow_load',
  FLOW_REPLAY: 'iris_flow_replay',
  /** M8 Stage B: persist the human-recorded flow from the live tab. */
  FLOW_SAVE_RECORDED: 'iris_flow_save_recorded',
  /** M8 Stage B: propose (+ opt-in apply) a nearest-match rebind for a drifted flow. */
  FLOW_HEAL: 'iris_flow_heal',
  /** M8 Stage B ANNOTATE: structured annotation → compiles into the recording's expect/dynamic/success. */
  ANNOTATE: 'iris_annotate',
  /** 0.3.7 RUNHISTORY: read cross-run history (.iris/project.json) + diff-vs-last for a name. */
  PROJECT: 'iris_project',
  /** 0.3.7 RUNHISTORY: explicitly record a run outcome (the manual companion to auto-recording). */
  RUN_RECORD: 'iris_run_record',
  /** N3 VISUAL (M11): capture a pixel screenshot (CDP/driven browser) → .iris/visual/<name>.png. */
  SCREENSHOT: 'iris_screenshot',
  /** N3 VISUAL (M11): perceptual-diff the live page against a saved visual baseline. */
  VISUAL_DIFF: 'iris_visual_diff',
  /** Live-control: end the session (→ ended + push PRESENTER). Handlers live in the tools facet. */
  END_SESSION: 'iris_end_session',
  /** Live-control: clear a pause (→ active). */
  RESUME: 'iris_resume',
  /** Live-control: drain the human→agent inbox (explicit poll). */
  MESSAGES: 'iris_messages',
} as const;
export type IrisTool = (typeof IrisTool)[keyof typeof IrisTool];

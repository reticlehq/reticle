/**
 * Wire-level constants. No free strings anywhere in Iris reference these directly —
 * every string/number that crosses the browser <-> bridge <-> agent boundary is named here.
 */

export const IRIS_DEFAULT_PORT = 4400;
export const IRIS_WS_PATH = '/iris';
export const IRIS_PROTOCOL_VERSION = 1;

/** Hard transport bounds shared by the browser and bridge. */
export const TRANSPORT_LIMITS = {
  MAX_MESSAGE_BYTES: 1024 * 1024,
  MAX_MESSAGES_PER_SECOND: 1000,
  MAX_SESSIONS: 32,
  MAX_PENDING_CONNECTIONS: 16,
  HELLO_TIMEOUT_MS: 5000,
  MAX_BUFFER_BYTES: 8 * 1024 * 1024,
  MAX_SESSION_ID_LENGTH: 128,
  MAX_URL_LENGTH: 4096,
  MAX_TITLE_LENGTH: 512,
  MAX_ADAPTERS: 32,
  MAX_ADAPTER_NAME_LENGTH: 128,
  MAX_TOKEN_LENGTH: 512,
  MAX_COMMAND_ID_LENGTH: 128,
  MAX_COMMAND_NAME_LENGTH: 128,
  MAX_REF_LENGTH: 128,
  MAX_ERROR_LENGTH: 4096,
  MAX_SERIALIZE_DEPTH: 8,
  MAX_COLLECTION_ITEMS: 200,
  MAX_OBJECT_KEYS: 200,
  MAX_STRING_LENGTH: 64 * 1024,
} as const;

/** Replacement used when sensitive data is removed before crossing the bridge. */
export const REDACTED_VALUE = '[REDACTED]';

/** Explicit opt-in argument required for potentially destructive actions. */
export const DANGEROUS_ACTION_CONFIRM_ARG = 'confirmDangerous';

/** Schema version stamped onto compiled replay programs. */
export const REPLAY_PROGRAM_VERSION = 1;

/** The git-checked Iris workspace directory + its layout. No free strings. */
export const IrisDir = {
  ROOT: '.iris',
  CONTRACT_FILE: 'contract.json',
  FLOWS_SUBDIR: 'flows',
  BASELINES_SUBDIR: 'baselines',
  /** cross-run memory — outcomes of past runs (the "did it behave like last time?" file). */
  PROJECT_FILE: 'project.json',
  /** opt-in pixel baselines — .iris/visual/<name>.png + <name>.diff.png. */
  VISUAL_SUBDIR: 'visual',
} as const;

/**
 * Structured reasons a screenshot/visual-diff could not produce a verdict (never
 * thrown as free strings). The visual layer is OPT-IN and CDP/Playwright-driven — it is NEVER
 * bundled into the always-on browser SDK — so NO_PROVIDER is the common "you must `iris drive`" case.
 */
export const VisualReason = {
  NO_PROVIDER: 'no-visual-provider', // no CDP/launched browser → cannot capture pixels
  CAPTURE_FAILED: 'capture-failed', // the page could not be screenshotted
  BASELINE_MISSING: 'baseline-missing', // iris_visual_diff with no saved baseline of that name
  DIMENSION_MISMATCH: 'dimension-mismatch', // current vs baseline differ in size — can't pixel-diff
} as const;
export type VisualReason = (typeof VisualReason)[keyof typeof VisualReason];

/** Actionable companion to NO_PROVIDER — the visual layer needs a driven browser. */
export const VISUAL_NO_PROVIDER_RECOMMENDATION =
  'visual capture needs a driven browser — start with `iris drive <url>` or set IRIS_CDP_URL; the always-on SDK does not ship a screenshotter';

/** Default per-pixel color-distance threshold (pixelmatch 0..1; higher = more lenient). */
export const VISUAL_PIXEL_THRESHOLD = 0.1;

/**
 * Autonomous "smart monkey" anomaly classes iris_crawl reports after clicking a
 * reachable control. Named so the agent (and tests) branch on cause, never on message text.
 */
export const CrawlAnomalyKind = {
  CONSOLE_ERROR: 'console-error', // the click logged a console.error / uncaught error
  FAILED_REQUEST: 'failed-request', // it fired a request that returned >= 400
  DEAD_CONTROL: 'dead-control', // it dispatched but the app did NOTHING (no DOM/net/route/signal)
} as const;
export type CrawlAnomalyKind = (typeof CrawlAnomalyKind)[keyof typeof CrawlAnomalyKind];

/**
 * Bounds for iris_scroll_to — how many viewport scrolls to try before giving up on
 * a virtualized/windowed list (which only renders visible rows, so a plain iris_query misses
 * off-screen items). Each scroll advances ~one viewport; the loop also stops early at the list end.
 */
export const SCROLL_FIND_DEFAULTS = {
  MAX_SCROLLS: 20,
} as const;

/** Bounds so a crawl always terminates and each click has time to settle. */
export const CRAWL_DEFAULTS = {
  /** Max controls clicked in one crawl (then `truncated:true`). */
  MAX_STEPS: 25,
  /** ms to wait for a click's reaction to land in the buffer before classifying. */
  SETTLE_MS: 300,
  /** HTTP status at/above which a response counts as a failed request. */
  FAILED_STATUS: 400,
} as const;

/** Schema version stamped into contract.json so a reader can reject/upgrade old files. */
export const CONTRACT_FILE_VERSION = 1;

/** Arg key on iris_capabilities selecting the on-disk contract over the live session. */
export const FROM_DISK_ARG = 'fromDisk';

/** Structured outcome when reading contract.json fails (never thrown to the agent). */
export const ContractReadError = {
  MISSING: 'contract-missing', // no .iris/contract.json on disk
  MALFORMED: 'contract-malformed', // present but not valid JSON / fails schema
} as const;
export type ContractReadError = (typeof ContractReadError)[keyof typeof ContractReadError];

/**
 * Schema version stamped into project.json so a reader can reject/upgrade old files.
 */
export const PROJECT_FILE_VERSION = 1;

/**
 * Structured outcome when reading project.json fails (never thrown to the agent).
 * Mirrors ContractReadError. NOTE: recordRun() self-heals a MALFORMED file (starts fresh) so a
 * corrupt history never wedges the agent; only the READ path (iris_project) surfaces MALFORMED.
 */
export const ProjectReadError = {
  MISSING: 'project-missing', // no .iris/project.json on disk
  MALFORMED: 'project-malformed', // present but not valid JSON / fails schema
} as const;
export type ProjectReadError = (typeof ProjectReadError)[keyof typeof ProjectReadError];

/** How a run record was produced. */
export const RunKind = {
  FLOW_REPLAY: 'flow_replay', // auto-recorded by iris_flow_replay
  MANUAL: 'manual', // explicitly recorded via iris_run_record
} as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

/**
 * The persisted outcome of a run. Distinct from ReplayStatus (a wire/replay
 * concept of ok|drift|error): RunStatus is the history concept and adds pass/fail. The replay
 * site maps ReplayStatus.OK→PASS, DRIFT→DRIFT, ERROR→ERROR.
 */
export const RunStatus = {
  PASS: 'pass',
  DRIFT: 'drift',
  ERROR: 'error',
  FAIL: 'fail',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * Bounds on project.json so the file stays small + diffable. recordRun keeps the
 * last PER_NAME runs of any single name, then caps the whole list to TOTAL most-recent overall.
 */
export const PROJECT_RUN_CAP = {
  PER_NAME: 50,
  TOTAL: 200,
} as const;

/** Schema version stamped onto on-disk flow files (.iris/flows/<name>.json). */
export const FLOW_FILE_VERSION = 1;

/** How a flow step is anchored to the live DOM at replay time (semantic, never a volatile ref). */
export const AnchorKind = {
  TESTID: 'testid', // { kind:'testid', value }
  ROLE: 'role', // { kind:'role', role, name? } — best-effort fallback
  SIGNAL: 'signal', // { kind:'signal', name } — wait/assert anchors
} as const;
export type AnchorKind = (typeof AnchorKind)[keyof typeof AnchorKind];

/**
 * The role marker for a DEGRADED step — one recorded with no resolvable
 * testid. It is kept (never dropped) but a volatile eXX ref is NEVER persisted in its place;
 * the step carries this placeholder ROLE anchor + degraded:true, a legible "add a data-testid
 * here" marker that a human/self-healing pass re-binds. Satisfies the anchor min(1).
 */
export const DEGRADED_ANCHOR_ROLE = 'unresolved';

/** Structured failure codes for flow disk ops (returned, never thrown as free strings). */
export const FlowErrorCode = {
  INVALID_NAME: 'flow_invalid_name', // path traversal / illegal chars
  NOT_FOUND: 'flow_not_found', // load of a missing flow
  PARSE_FAILED: 'flow_parse_failed', // on-disk JSON failed zod validation
  NO_RECORDING: 'flow_no_recording', // save with no compiled program by that name
} as const;
export type FlowErrorCode = (typeof FlowErrorCode)[keyof typeof FlowErrorCode];

/** A flow name must be a single safe path segment (no '/', '\\', '..', leading dot). */
export const FLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

/**
 * The outcome of replaying an on-disk flow by re-resolving its
 * semantic anchors against the live DOM. `drift` (an anchor missed → contract changed) is
 * cleanly separated from `error` (the flow could not load or an action failed) and `ok`.
 */
export const ReplayStatus = {
  OK: 'ok', // every anchor resolved and every step ran green
  DRIFT: 'drift', // an anchor missed (testid renamed / signal not observed) — legible drift returned
  ERROR: 'error', // the flow could not load or a resolved action failed
} as const;
export type ReplayStatus = (typeof ReplayStatus)[keyof typeof ReplayStatus];

/**
 * Why an anchor failed to resolve at replay time (the "whose fault is
 * it" reason kind). Drives the human `reason` sentence and whether a nearest-match is offered.
 */
export const DriftReason = {
  TESTID_NOT_FOUND: 'testid_not_found', // a testid anchor resolved to zero live elements
  SIGNAL_NOT_OBSERVED: 'signal_not_observed', // a signal anchor never fired within the timeout
} as const;
export type DriftReason = (typeof DriftReason)[keyof typeof DriftReason];

/** Default timeout (ms) a signal anchor waits to be observed at replay. */
export const FLOW_SIGNAL_TIMEOUT_MS = 4000;

/**
 * The structured annotation kinds a human can attach while recording.
 * FIRST CUT: only these four structured kinds compile to flow fields (via a toolbar menu +
 * a signal <select> drawn from registered capabilities). Free natural-language annotation →
 * predicate compilation is explicitly OUT this cut (no NL parser). `wait-for` / `ignore-region`
 * from the plan grammar are also future — only the four requested kinds ship here.
 */
export const AnnotationKind = {
  ASSERT_SIGNAL: 'assert-signal', // → step.expect.signal  (invariant)
  ASSERT_VISIBLE: 'assert-visible', // → step.expect.element (invariant)
  MARK_DYNAMIC: 'mark-dynamic', // → flow.dynamic[]      (don't assert words/content)
  SUCCESS_STATE: 'success-state', // → flow.success        (golden end condition)
} as const;
export type AnnotationKind = (typeof AnnotationKind)[keyof typeof AnnotationKind];

/** Recorder lifecycle phases (drives the toolbar UI + the capture gate). */
export const RecorderPhase = {
  IDLE: 'idle', // listeners inert, no steps captured
  RECORDING: 'recording', // capture-phase listeners live
  ANNOTATING: 'annotating', // recording paused, awaiting an annotation target/kind
} as const;
export type RecorderPhase = (typeof RecorderPhase)[keyof typeof RecorderPhase];

/**
 * Structured codes for the recorded-save server tool (returned, never thrown).
 */
export const RecordedSaveError = {
  NO_RECORDED_FLOW: 'flow_no_recorded', // no FLOW_RECORDED event for the session
  INVALID_NAME: 'flow_invalid_name', // reuses FlowErrorCode.INVALID_NAME semantics
} as const;
export type RecordedSaveError = (typeof RecordedSaveError)[keyof typeof RecordedSaveError];

/**
 * Outcome of iris_flow_heal (distinct from ReplayStatus — adds heal verbs).
 * Rebinds testid anchors only (role/name/signal re-anchoring is future). A confident nearest-match
 * is required before any disk write — the "never silently rewrite" invariant.
 */
export const HealStatus = {
  HEALED: 'healed', // apply:true and >=1 anchor rewritten on disk
  DRIFT: 'drift', // apply:false: confident proposal(s) returned, file untouched
  UNHEALABLE: 'unhealable', // drift exists but no proposal cleared the confidence floor
  NOTHING_TO_HEAL: 'nothing_to_heal', // replay was green
  ERROR: 'error', // flow missing/malformed/invalid-name, or a resolved action failed
} as const;
export type HealStatus = (typeof HealStatus)[keyof typeof HealStatus];

/**
 * Minimum normalized confidence (0,1] a nearest-match rebind must clear before it is
 * eligible to be APPLIED (or surfaced as a confident proposal). Below this, drift is reported but
 * NEVER auto-rewritten — the "never silently rewrite" invariant has a single numeric home here.
 */
export const HEAL_CONFIDENCE_MIN = 0.5;

/**
 * What a structured annotation binds to. STEP folds onto the LAST captured
 * step's expect (assert-signal / assert-visible); FLOW folds onto the flow header (mark-dynamic →
 * dynamic[], success-state → success).
 */
export const AnnotationTarget = {
  STEP: 'step',
  FLOW: 'flow',
} as const;
export type AnnotationTarget = (typeof AnnotationTarget)[keyof typeof AnnotationTarget];

/**
 * Structured failure codes for the annotate compiler/tool (returned, never
 * thrown / free strings). NO_ACTIVE_RECORDING = annotate() with nothing recording; NO_STEP_TO_
 * ANNOTATE = an assert-* with zero captured steps yet; UNKNOWN_KIND = kind ∉ AnnotationKind (or a
 * free natural-language string — see AnnotationSchema's FUTURE note); MISSING_FIELD = e.g. a
 * success-state with neither signal nor testid.
 */
export const AnnotationErrorCode = {
  NO_ACTIVE_RECORDING: 'annotate_no_recording',
  NO_STEP_TO_ANNOTATE: 'annotate_no_step',
  UNKNOWN_KIND: 'annotate_unknown_kind',
  MISSING_FIELD: 'annotate_missing_field',
} as const;
export type AnnotationErrorCode = (typeof AnnotationErrorCode)[keyof typeof AnnotationErrorCode];

/** Leading word of the compiled-predicate confirmation ("will assert …"). */
export const COMPILED_PREDICATE_PREFIX = 'will';

/** Bounds for the per-session ring buffer (see plan/02-architecture.md). */
export const RING_BUFFER_DEFAULTS = {
  MAX_EVENTS: 2000,
  MAX_AGE_MS: 60_000,
  MAX_BYTES: TRANSPORT_LIMITS.MAX_BUFFER_BYTES,
} as const;

/** The observers that can be installed in the browser SDK (plan/03). */
export const ObserverType = {
  DOM: 'dom',
  NETWORK: 'network',
  ROUTE: 'route',
  CONSOLE: 'console',
  VISIBILITY: 'visibility',
  ANIMATION: 'animation',
  SCROLL: 'scroll',
  SIGNAL: 'signal',
  STATE: 'state',
} as const;
export type ObserverType = (typeof ObserverType)[keyof typeof ObserverType];

/** Normalized event types pushed into the ring buffer. */
export const EventType = {
  DOM_ADDED: 'dom.added',
  DOM_REMOVED: 'dom.removed',
  DOM_ATTR: 'dom.attr',
  DOM_TEXT: 'dom.text',
  NET_REQUEST: 'net.request',
  NET_PENDING: 'net.pending',
  ROUTE_CHANGE: 'route.change',
  CONSOLE_LOG: 'console.log',
  CONSOLE_WARN: 'console.warn',
  CONSOLE_ERROR: 'console.error',
  ERROR_UNCAUGHT: 'error.uncaught',
  VISIBLE_SHOWN: 'visible.shown',
  VISIBLE_HIDDEN: 'visible.hidden',
  ANIM_START: 'anim.start',
  ANIM_END: 'anim.end',
  SCROLL_POSITION: 'scroll.position',
  REVEAL_SHOWN: 'reveal.shown',
  SIGNAL: 'signal',
  STATE_CHANGE: 'state.change',
  /** page-level visibility/focus health (distinct from element-level VISIBLE_*). */
  PAGE_HEALTH: 'page.health',
  /** browser → bridge: a human recording compiled in-page. */
  FLOW_RECORDED: 'flow.recorded',
  /** synthetic: browser transport queue overflowed; events were dropped. `data: { dropped: number }`. */
  TRANSPORT_OVERFLOW: 'transport.overflow',
  /**
   * Live-control: browser → bridge. A human acted on the presenter panel.
   * `data: { kind: HumanControlKind; text?: string }`. Rides the existing EventMessage.
   */
  HUMAN_CONTROL: 'human.control',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * Live-control: per-session lifecycle state (server-owned). The presenter panel mirrors it.
 * `active → paused → active … → ended`; `ended` is terminal.
 */
export const SessionState = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/**
 * Sentinel session label meaning "give this tab its own unique id". The SDK maps it (and an absent
 * label) to a per-tab id so several tabs — a human tab + an Iris-driven tour, a Director-cut popup —
 * never collide on one session id. Pass an explicit label only when tabs should intentionally share.
 */
export const SESSION_AUTO = 'auto';

/** Live-control: kinds a human can emit from the panel (the `kind` of a HUMAN_CONTROL event). */
export const HumanControlKind = {
  PAUSE: 'pause',
  RESUME: 'resume',
  END: 'end',
  MESSAGE: 'message',
} as const;
export type HumanControlKind = (typeof HumanControlKind)[keyof typeof HumanControlKind];

/**
 * SDK page-health heartbeat cadence (native timer) and the server's
 * throttle threshold. Kept named so the server's staleness check can be reasoned about
 * against the SDK's heartbeat (≈ 2 missed heartbeats ⇒ throttled).
 */
export const SESSION_HEALTH = {
  HEARTBEAT_MS: 5_000,
  /** lastSeenMs beyond this ⇒ throttled (≈ 2 missed heartbeats). */
  STALE_THRESHOLD_MS: 12_000,
} as const;

/**
 * Server-authoritative session liveness. The browser-side idle timer is throttled in a backgrounded
 * tab and dies entirely if the agent (MCP client) kills the bridge — so the Node server (immune to
 * throttling) owns the decision: a session whose AGENT has been idle past `IDLE_END_MS` is reaped and
 * ended via a PRESENTER push (which a throttled tab still receives). `BRIDGE_LOST_MS` is the browser's
 * own fallback: when it cannot reach the bridge for this long (server/agent process gone), it ends the
 * session itself so the HUD never sits "running" forever.
 */
export const SESSION_LIFECYCLE = {
  /** Default agent-idle window before the server reaps a session. Agent-tunable via iris_session. */
  IDLE_END_MS: 300_000,
  /** Floor for a tuned idle window (so an agent can't disable the safety net). */
  IDLE_END_MIN_MS: 5_000,
  /** How often the server reaper sweeps sessions for idle/disconnected ones. */
  REAP_INTERVAL_MS: 5_000,
  /** Browser fallback: continuous failure to reach the bridge for this long ⇒ self-end the session. */
  BRIDGE_LOST_MS: 15_000,
} as const;

/**
 * Coding-agent session hygiene thresholds. Coding agents (Claude Code, Codex, Cursor) often
 * complete their task and close their context without calling iris_end_session. These constants
 * drive two passive reminder layers: a one-time session_lease on first call, and recurring
 * session_age_warning fields after WARN_AFTER_MS.
 */
export const SESSION_LEASE = {
  /** ms after which age warnings appear on every session-bound tool result. */
  WARN_AFTER_MS: 600_000, // 10 minutes
  /** ms after which iris_sessions marks a session as stale. */
  STALE_AFTER_MS: 1_800_000, // 30 minutes
} as const;

/** Why the SDK emitted a PAGE_HEALTH event. */
export const HealthReason = {
  VISIBILITY: 'visibilitychange',
  FOCUS: 'focus',
  BLUR: 'blur',
  HEARTBEAT: 'heartbeat',
  INITIAL: 'initial',
} as const;
export type HealthReason = (typeof HealthReason)[keyof typeof HealthReason];

/** Surfaced on act/assert results when the target tab is throttled. */
export const THROTTLED_WARNING =
  'tab throttled; timer/rAF/pointer gestures may silently no-op — refocus before driving';

/**
 * Actionable companion to THROTTLED_WARNING. Surfaced on act/assert results and
 * iris_sessions rows when a tab is hidden/throttled and may be un-focusable/un-recoverable from
 * the in-page SDK + CDP path. Points at the `iris drive` escape hatch (a guaranteed scriptable
 * context). Iris cannot bring such a tab to front or recover it, so it names the limit instead.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION =
  'tab hidden/throttled and may be un-focusable from here; refocus it, or run `iris drive <url>` for a guaranteed scriptable context';

/** Which input path executed an action — native (CDP/Playwright) vs synthetic dispatchEvent. */
export const InputMode = {
  REAL: 'real',
  SYNTHETIC: 'synthetic',
} as const;
export type InputMode = (typeof InputMode)[keyof typeof InputMode];

/**
 * Why a pointer action ran SYNTHETIC even though a real-input provider is configured. Attached as
 * `inputModeReason` so a real→synthetic fallback is never silent (field bug #2) — the agent can
 * tell "I couldn't locate the element" from "the page isn't correlated to a CDP target".
 */
export const InputModeReason = {
  NOT_POINTER: 'not-a-pointer-action', // fill/type never use native input
  // Clicks default to the occlusion-honest synthetic path ("don't click, run the code") even with a
  // provider configured; pass action arg native:true to force a trusted native click when needed.
  SYNTHETIC_CLICK_PREFERRED: 'synthetic-click-preferred',
  PAGE_NOT_CORRELATED: 'page-not-correlated-to-a-cdp-target', // no CDP page matches session.url
  ELEMENT_NOT_LOCATABLE: 'element-not-locatable', // INSPECT returned no box (off-screen/stale ref)
  DRAG_TARGET_UNRESOLVED: 'drag-target-unresolved', // drag toRef missing or not locatable
  PROVIDER_DECLINED: 'provider-declined', // provider chose not to perform
  PROVIDER_ERROR: 'provider-error', // provider threw → fell back to synthetic
} as const;
export type InputModeReason = (typeof InputModeReason)[keyof typeof InputModeReason];

/** Best-effort caveats attached to action results so the agent can interpret a no-op. */
export const ActionWarning = {
  HOVER_NATIVE_ENTER_LEAVE:
    'target has enter/leave handlers; synthetic hover may not trigger them — expect no state change',
  /** real-input provider was available but failed; the action fell back to synthetic dispatch. */
  REAL_INPUT_FELL_BACK:
    'real-input provider was available but failed; fell back to synthetic dispatch',
  /**
   * The click point was covered by another element. Synthetic dispatch still delivered the event to
   * your target, but a real user could NOT click it — treat the target as visually blocked, not
   * actionable. Scroll it into a clear area or dismiss the overlay on top.
   */
  CLICK_OCCLUDED:
    'target is visually occluded by another element; a real user could not click it (synthetic dispatch still delivered the event) — dismiss the overlay or scroll the target clear',
} as const;
export type ActionWarning = (typeof ActionWarning)[keyof typeof ActionWarning];

/** Failure modes when Iris launches/drives its own browser (`iris drive`). */
export const DriveErrorCode = {
  PLAYWRIGHT_MISSING: 'playwright_missing',
  LAUNCH_FAILED: 'launch_failed',
  NAVIGATE_FAILED: 'navigate_failed',
} as const;
export type DriveErrorCode = (typeof DriveErrorCode)[keyof typeof DriveErrorCode];

/** Human-facing message when the optional playwright dep is absent. */
export const DRIVE_PLAYWRIGHT_MISSING_MSG =
  "iris drive needs the optional 'playwright' package — install it: pnpm add -D playwright && npx playwright install chromium";

/** Actions the executor can perform against a ref (plan/03 + plan/05). */
export const ActionType = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  HOVER: 'hover',
  FOCUS: 'focus',
  BLUR: 'blur',
  FILL: 'fill',
  TYPE: 'type',
  CLEAR: 'clear',
  SELECT: 'select',
  CHECK: 'check',
  UNCHECK: 'uncheck',
  SUBMIT: 'submit',
  PRESS: 'press',
  UPLOAD: 'upload',
  SCROLL_INTO_VIEW: 'scrollIntoView',
  DRAG: 'drag',
  WEBMCP: 'webmcp',
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

/** Why an action's settle wait ended without a real animation frame (F1). */
export const SettleReason = {
  TIMEOUT: 'timeout',
  THROTTLED: 'throttled',
} as const;
export type SettleReason = (typeof SettleReason)[keyof typeof SettleReason];

/** Outcome reasons for a bounded component-state read. Store reads never use these. */
export const ComponentStateReason = {
  UNAVAILABLE: 'component-state-unavailable',
} as const;
export type ComponentStateReason = (typeof ComponentStateReason)[keyof typeof ComponentStateReason];

/**
 * Result of a component-state read attempt, discriminated on `ok`. Crosses
 * browser -> bridge -> agent as `result.component`, so the contract lives in protocol.
 * Always JSON-serializable: hook values are sanitized (no functions/DOM nodes/cycles).
 */
export interface ComponentStateResult {
  ok: boolean;
  reason?: ComponentStateReason;
  /** Component display name, when known. */
  component?: string;
  /** Positional, JSON-safe hook states. */
  hooks?: unknown[];
}

/** Element states the assertion engine can check (plan/06). */
export const ElementState = {
  VISIBLE: 'visible',
  HIDDEN: 'hidden',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  CHECKED: 'checked',
  EXPANDED: 'expanded',
  FOCUSED: 'focused',
  PRESENT: 'present',
} as const;
export type ElementState = (typeof ElementState)[keyof typeof ElementState];

/** Query strategies, aligned with Testing Library semantics (plan/04). */
export const QueryBy = {
  ROLE: 'role',
  TEXT: 'text',
  LABEL: 'label',
  PLACEHOLDER: 'placeholder',
  TESTID: 'testid',
  ALT: 'alt',
} as const;
export type QueryBy = (typeof QueryBy)[keyof typeof QueryBy];

/** Commands the bridge sends to the browser SDK (the `name` field of a CommandMessage). */
export const IrisCommand = {
  SNAPSHOT: 'snapshot',
  QUERY: 'query',
  MATCH: 'match',
  INSPECT: 'inspect',
  ACT: 'act',
  ACT_SEQUENCE: 'act_sequence',
  ANIMATIONS: 'animations',
  NARRATE: 'narrate',
  CLOCK: 'clock',
  CAPABILITIES: 'capabilities',
  STATE_READ: 'state_read',
  /** scroll a ref's nearest scrollable container by ~a viewport (virtualized lists). */
  SCROLL: 'scroll',
  /** Session lifecycle: agent tunes the presenter session (e.g. idle-end timeout) for the app's needs. */
  SESSION_CONFIG: 'session_config',
  /**
   * Live-control: bridge → browser. Pushes the current session state to the panel so an
   * AGENT-driven pause/end keeps the presenter in sync. `args: { state, text? }`.
   */
  PRESENTER: 'presenter',
  /** Navigate the page to a new URL. `args: { url: string }`. */
  NAVIGATE: 'navigate',
  /** Reload the page. `args: { hard?: boolean }` — hard clears the cache via location replace trick. */
  REFRESH: 'refresh',
} as const;
export type IrisCommand = (typeof IrisCommand)[keyof typeof IrisCommand];

/** Presenter intent shown to the human watcher: is the agent reading or acting? */
export const PresenterMode = {
  IDLE: 'idle',
  READING: 'reading',
  ACTING: 'acting',
} as const;
export type PresenterMode = (typeof PresenterMode)[keyof typeof PresenterMode];

/** Snapshot rendering modes (plan/04). */
export const SnapshotMode = {
  FULL: 'full',
  INTERACTIVE: 'interactive',
  STATUS: 'status',
} as const;
export type SnapshotMode = (typeof SnapshotMode)[keyof typeof SnapshotMode];

/** Top-level envelope discriminator for messages on the WS channel. */
export const MessageKind = {
  HELLO: 'hello',
  COMMAND: 'command',
  COMMAND_RESULT: 'command_result',
  EVENT: 'event',
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

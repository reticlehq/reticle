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
  /** Human review marks: the note the human types when flagging a mistake on the page. */
  MAX_MARK_NOTE_LENGTH: 2000,
  /** Human review marks: the legible element label that pins the mark (e.g. "Submit button"). */
  MAX_MARK_LABEL_LENGTH: 256,
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

/** How long to wait between npm registry update checks (24 h). */
export const UpdateCheckIntervalMs = 24 * 60 * 60 * 1000;

/** States of the server update lifecycle exposed by iris_version_info. */
export const UpdateStatus = {
  UP_TO_DATE: 'up_to_date',
  UPDATE_AVAILABLE: 'update_available',
  CHECKING: 'checking',
} as const;
export type UpdateStatus = (typeof UpdateStatus)[keyof typeof UpdateStatus];

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

/** On-disk artifact constants (project/flow/replay/recorder/heal/annotation) live here. */
export * from './flow-constants.js';

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
  /**
   * Human review: browser → bridge. A human pinned a mistake to an element on the running page
   * (the "annotate the bug where you see it" loop). `data` narrows to HumanMarkDataSchema — a note
   * plus a re-resolvable element anchor (and its source file:line when the framework stamped one) so
   * the agent that drains the mark knows exactly which element and which source to fix.
   */
  HUMAN_MARK: 'human.mark',
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
 * Human review marks: the durability tier of the anchor that pins a mark to an element. Mirrors the
 * browser's auto-anchor AnchorStrategy values (testid > component@source > role > position) so the
 * agent draining a mark knows how trustworthy the element address is. Wire-owned here because the
 * mark crosses browser → bridge → agent; the browser maps its synthesized anchor onto these.
 */
export const MarkAnchorStrategy = {
  TESTID: 'testid',
  COMPONENT: 'component',
  ROLE: 'role',
  POSITION: 'position',
} as const;
export type MarkAnchorStrategy = (typeof MarkAnchorStrategy)[keyof typeof MarkAnchorStrategy];

/** Human review marks: lifecycle of a mark in the server-side review store. */
export const MarkStatus = {
  /** Flagged by the human, not yet addressed by the agent. */
  PENDING: 'pending',
  /** The agent claimed the mark as fixed (iris_review resolve). Terminal. */
  RESOLVED: 'resolved',
} as const;
export type MarkStatus = (typeof MarkStatus)[keyof typeof MarkStatus];

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
  /**
   * Default agent-idle window before the server hands the session back to the human as WAITING (the
   * agent went quiet between turns). Short by design so the panel reflects "your turn" fast; the agent
   * normally signals this immediately via iris_yield, this is the safety net. Agent-tunable (raise it
   * for slow apps) via iris_session.
   */
  IDLE_END_MS: 8_000,
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

/** Why an action's settle wait ended without a real animation frame. */
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
  /** Resolve by component identity / source location (auto-anchors — addresses any element with
   * no hand-added testid). Pair with ElementQuery.component and/or .source. */
  COMPONENT: 'component',
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

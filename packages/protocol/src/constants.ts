/**
 * Wire-level constants. No free strings anywhere in Reticle reference these directly —
 * every string/number that crosses the browser <-> bridge <-> agent boundary is named here.
 */

export const RETICLE_DEFAULT_PORT = 4400;
export const RETICLE_WS_PATH = '/reticle';
export const RETICLE_PROTOCOL_VERSION = 1;

/**
 * Namespaced URL params a pooled/headless launcher appends to the app URL so the app's own SDK adopts
 * the lease's identity (session + project) on connect — no app code changes. Wire contract shared by
 * the server (BrowserPool/lease tools) and the browser SDK; namespaced to avoid clashing with the
 * app's own query params.
 */
export const RETICLE_URL_PARAM = {
  SESSION: '__reticle_session',
  PROJECT: '__reticle_project',
} as const;

/** The loopback bind address. The daemon/bridge bind here by default — never expose Reticle off-host. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Every environment variable Reticle reads, named once. A misspelled inline env string silently
 * disables the control it gates (e.g. a typo'd `RETICLE_TOKEN` would disable auth) — so the names live
 * here and nowhere else. The values are the literal process.env keys.
 */
export const ReticleEnv = {
  /** Shared-secret the browser SDK must present in HELLO; absent ⇒ loopback-trust only. */
  TOKEN: 'RETICLE_TOKEN',
  /** Bridge bind host. Defaults to loopback; setting anything else is opt-in remote exposure. */
  HOST: 'RETICLE_HOST',
  /** Comma-separated WS Origin allow-list for the bridge. */
  ALLOWED_ORIGINS: 'RETICLE_ALLOWED_ORIGINS',
  /** Bridge/daemon WS port override. */
  PORT: 'RETICLE_PORT',
  /** Attach to an already-running browser over CDP instead of launching one. */
  CDP_URL: 'RETICLE_CDP_URL',
  /** Max simultaneous leased headless contexts in the browser pool (resource cap). */
  MAX_CONTEXTS: 'RETICLE_MAX_CONTEXTS',
  /** Bearer token required by the optional `reticle serve --http` verify endpoint. */
  VERIFY_TOKEN: 'RETICLE_VERIFY_TOKEN',
  /** Ms of continuous idleness (no agent, no browser session, no lease) before the daemon self-exits;
   * `0` disables. Keeps Reticle from lingering on a user's machine after the editor closes. */
  IDLE_SHUTDOWN: 'RETICLE_IDLE_SHUTDOWN_MS',
} as const;

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

/** The git-checked Reticle workspace directory + its layout. No free strings. */
export const ReticleDir = {
  ROOT: '.reticle',
  CONTRACT_FILE: 'contract.json',
  FLOWS_SUBDIR: 'flows',
  BASELINES_SUBDIR: 'baselines',
  /** cross-run memory — outcomes of past runs (the "did it behave like last time?" file). */
  PROJECT_FILE: 'project.json',
  /** opt-in pixel baselines — .reticle/visual/<name>.png + <name>.diff.png. */
  VISUAL_SUBDIR: 'visual',
  /** verification-run artifacts — .reticle/runs/<runId>.json (the OEM/CI-consumable verdict). */
  RUNS_SUBDIR: 'runs',
} as const;

/**
 * Structured reasons a screenshot/visual-diff could not produce a verdict (never
 * thrown as free strings). The visual layer is OPT-IN and CDP/Playwright-driven — it is NEVER
 * bundled into the always-on browser SDK — so NO_PROVIDER is the common "you must `reticle drive`" case.
 */
export const VisualReason = {
  NO_PROVIDER: 'no-visual-provider', // no CDP/launched browser → cannot capture pixels
  CAPTURE_FAILED: 'capture-failed', // the page could not be screenshotted
  BASELINE_MISSING: 'baseline-missing', // reticle_visual_diff with no saved baseline of that name
  DIMENSION_MISMATCH: 'dimension-mismatch', // current vs baseline differ in size — can't pixel-diff
} as const;
export type VisualReason = (typeof VisualReason)[keyof typeof VisualReason];

/** Actionable companion to NO_PROVIDER — the visual layer needs a driven browser. */
export const VISUAL_NO_PROVIDER_RECOMMENDATION =
  'visual capture needs a driven browser — start with `reticle drive <url>` or set RETICLE_CDP_URL; the always-on SDK does not ship a screenshotter';

/** Default per-pixel color-distance threshold (pixelmatch 0..1; higher = more lenient). */
export const VISUAL_PIXEL_THRESHOLD = 0.1;

/**
 * Autonomous "smart monkey" anomaly classes reticle_crawl reports after clicking a
 * reachable control. Named so the agent (and tests) branch on cause, never on message text.
 */
export const CrawlAnomalyKind = {
  CONSOLE_ERROR: 'console-error', // the click logged a console.error / uncaught error
  FAILED_REQUEST: 'failed-request', // it fired a request that returned >= 400
  DEAD_CONTROL: 'dead-control', // it dispatched but the app did NOTHING (no DOM/net/route/signal)
} as const;
export type CrawlAnomalyKind = (typeof CrawlAnomalyKind)[keyof typeof CrawlAnomalyKind];

/**
 * Bounds for reticle_scroll_to — how many viewport scrolls to try before giving up on
 * a virtualized/windowed list (which only renders visible rows, so a plain reticle_query misses
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

/** Schema version stamped into contract.json so a reader can reject/upgrade old files. */
export const CONTRACT_FILE_VERSION = 1;

/** Arg key on reticle_capabilities selecting the on-disk contract over the live session. */
export const FROM_DISK_ARG = 'fromDisk';

/** Structured outcome when reading contract.json fails (never thrown to the agent). */
export const ContractReadError = {
  MISSING: 'contract-missing', // no .reticle/contract.json on disk
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

/** Failure modes when Reticle launches/drives its own browser (`reticle drive`). */
export const DriveErrorCode = {
  PLAYWRIGHT_MISSING: 'playwright_missing',
  LAUNCH_FAILED: 'launch_failed',
  NAVIGATE_FAILED: 'navigate_failed',
} as const;
export type DriveErrorCode = (typeof DriveErrorCode)[keyof typeof DriveErrorCode];

/** Human-facing message when the optional playwright dep is absent. */
export const DRIVE_PLAYWRIGHT_MISSING_MSG =
  "reticle drive needs the optional 'playwright' package — install it: pnpm add -D playwright && npx playwright install chromium";

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
export const ReticleCommand = {
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
  /** Bridge → browser: the saved flows the human can replay from the panel. `args: { flows: [{name}] }`. */
  FLOWS: 'flows',
} as const;
export type ReticleCommand = (typeof ReticleCommand)[keyof typeof ReticleCommand];

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

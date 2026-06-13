/**
 * Wire-level constants. No free strings anywhere in Iris reference these directly —
 * every string/number that crosses the browser <-> bridge <-> agent boundary is named here.
 */

export const IRIS_DEFAULT_PORT = 4400;
export const IRIS_WS_PATH = '/iris';
export const IRIS_PROTOCOL_VERSION = 1;

/** Schema version stamped onto compiled replay programs (G6). */
export const REPLAY_PROGRAM_VERSION = 1;

/** Bounds for the per-session ring buffer (see plan/02-architecture.md). */
export const RING_BUFFER_DEFAULTS = {
  MAX_EVENTS: 2000,
  MAX_AGE_MS: 60_000,
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
  /** F2: page-level visibility/focus health (distinct from element-level VISIBLE_*). */
  PAGE_HEALTH: 'page.health',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * F2 session health: SDK page-health heartbeat cadence (native timer) and the server's
 * throttle threshold. Kept named so the server's staleness check can be reasoned about
 * against the SDK's heartbeat (≈ 2 missed heartbeats ⇒ throttled).
 */
export const SESSION_HEALTH = {
  HEARTBEAT_MS: 5_000,
  /** lastSeenMs beyond this ⇒ throttled (≈ 2 missed heartbeats). */
  STALE_THRESHOLD_MS: 12_000,
} as const;

/** Why the SDK emitted a PAGE_HEALTH event (F2). */
export const HealthReason = {
  VISIBILITY: 'visibilitychange',
  FOCUS: 'focus',
  BLUR: 'blur',
  HEARTBEAT: 'heartbeat',
  INITIAL: 'initial',
} as const;
export type HealthReason = (typeof HealthReason)[keyof typeof HealthReason];

/** Surfaced on act/assert results when the target tab is throttled (F2). */
export const THROTTLED_WARNING =
  'tab throttled; timer/rAF/pointer gestures may silently no-op — refocus before driving';

/**
 * P2-surface: actionable companion to THROTTLED_WARNING. Surfaced on act/assert results and
 * iris_sessions rows when a tab is hidden/throttled and may be un-focusable/un-recoverable from
 * the in-page SDK + CDP path. Points at the `iris drive` escape hatch (a guaranteed scriptable
 * context). Iris cannot bring such a tab to front or recover it, so it names the limit instead.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION =
  'tab hidden/throttled and may be un-focusable from here; refocus it, or run `iris drive <url>` for a guaranteed scriptable context';

/** R1: which input path executed an action — native (CDP/Playwright) vs synthetic dispatchEvent. */
export const InputMode = {
  REAL: 'real',
  SYNTHETIC: 'synthetic',
} as const;
export type InputMode = (typeof InputMode)[keyof typeof InputMode];

/** Best-effort caveats attached to action results so the agent can interpret a no-op (F3). */
export const ActionWarning = {
  HOVER_NATIVE_ENTER_LEAVE:
    'target has enter/leave handlers; synthetic hover may not trigger them — expect no state change',
  /** R1: real-input provider was available but failed; the action fell back to synthetic dispatch. */
  REAL_INPUT_FELL_BACK:
    'real-input provider was available but failed; fell back to synthetic dispatch',
} as const;
export type ActionWarning = (typeof ActionWarning)[keyof typeof ActionWarning];

/** P2-drive: failure modes when Iris launches/drives its own browser (`iris drive`). */
export const DriveErrorCode = {
  PLAYWRIGHT_MISSING: 'playwright_missing',
  LAUNCH_FAILED: 'launch_failed',
  NAVIGATE_FAILED: 'navigate_failed',
} as const;
export type DriveErrorCode = (typeof DriveErrorCode)[keyof typeof DriveErrorCode];

/** P2-drive: human-facing message when the optional playwright dep is absent. */
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

/** Outcome reasons for a bounded component-state read (F5). Store reads never use these. */
export const ComponentStateReason = {
  UNAVAILABLE: 'component-state-unavailable',
} as const;
export type ComponentStateReason = (typeof ComponentStateReason)[keyof typeof ComponentStateReason];

/**
 * Result of a component-state read attempt (F5), discriminated on `ok`. Crosses
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
} as const;
export type IrisCommand = (typeof IrisCommand)[keyof typeof IrisCommand];

/** Presenter intent shown to the human watcher (H2): is the agent reading or acting? */
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

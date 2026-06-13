/**
 * Wire-level constants. No free strings anywhere in Iris reference these directly —
 * every string/number that crosses the browser <-> bridge <-> agent boundary is named here.
 */

export const IRIS_DEFAULT_PORT = 4400;
export const IRIS_WS_PATH = '/iris';
export const IRIS_PROTOCOL_VERSION = 1;

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
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

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
  WEBMCP: 'webmcp',
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

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
} as const;
export type IrisCommand = (typeof IrisCommand)[keyof typeof IrisCommand];

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

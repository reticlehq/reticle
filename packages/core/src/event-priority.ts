import { EventType } from './constants.js';

/**
 * Which events survive the bridge's rate cap.
 *
 * The cap exists because a busy app can emit faster than the bridge can absorb. But dropping
 * indiscriminately is the wrong sampling policy: event volume is inversely correlated with event
 * value. A React commit storm emits thousands of `render.commit`/`dom.*` per second, while the events
 * an assertion actually turns on — a network call, an uncaught error, a route change — are rare.
 * First-come-first-dropped therefore spends the whole budget on churn and loses exactly the signal
 * the agent asked about.
 *
 * Measured on a react-admin renderer with a render loop: 11,138 events dropped in one window, and the
 * single IPC call under test was among them. The assertion came back `unknown` — honest, but blind.
 *
 * So over the cap we drop the high-volume/low-value kinds first and keep a reserve for these. The
 * reserve is bounded (see RATE_CAP_HIGH_VALUE_RESERVE_RATIO) — a flood of errors is still a flood,
 * and going unbounded here would just move the overload rather than shed it.
 */
export const HIGH_VALUE_EVENT_TYPES: ReadonlySet<string> = new Set([
  EventType.NET_REQUEST,
  EventType.NET_PENDING,
  EventType.NET_STREAM,
  EventType.NET_DETAIL,
  EventType.CONSOLE_ERROR,
  EventType.CONSOLE_WARN,
  EventType.ERROR_UNCAUGHT,
  EventType.ROUTE_CHANGE,
  EventType.SIGNAL,
  EventType.STORAGE_CHANGE,
  EventType.FLOW_RECORDED,
  // The synthetic honesty events. Dropping these is self-defeating: they are how a sampled window
  // announces that it is sampled, so losing them turns a known blind spot into a silent one.
  EventType.TRANSPORT_OVERFLOW,
  EventType.TRUNCATED,
  EventType.BLIND_SPOT,
]);

/**
 * The over-cap reserve for high-value events, as a multiple of the cap. Total admitted per second is
 * therefore bounded at `cap * (1 + ratio)` — still a hard bound, just one that spends its last slots
 * on the events worth keeping.
 */
export const RATE_CAP_HIGH_VALUE_RESERVE_RATIO = 1;

export function isHighValueEvent(type: string): boolean {
  return HIGH_VALUE_EVENT_TYPES.has(type);
}

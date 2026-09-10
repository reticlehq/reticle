import {
  BrowserBrand,
  EventType,
  BUFFER_EVICTION_WARNING,
  THROTTLED_STARVED_NOTE,
  THROTTLED_WARNING,
  type ReticleEvent,
} from '@reticlehq/core';
import type { Session } from './session.js';

/**
 * The health block spliced onto act/assert results. Defined here rather than in session.ts: this is
 * the module that builds it, and session.ts was over the file-size cap.
 */
export interface SessionHealth {
  lastSeenMs: number;
  throttled: boolean;
  focused: boolean;
  /** present only when hidden/throttled — points at the `reticle drive` escape hatch. */
  recommendation?: string;
  /**
   * How long the OLDEST unanswered request has been in flight, when that is long enough to matter.
   *
   * Present only past `PENDING_NAVIGATION_NOTICE_MS`, so a healthy session costs nothing. Both
   * reporters on the hung-server issue said this alone would have been enough for them: one sat on
   * an RSC fetch stuck pending for 170+ seconds across many calls, the other on a dev server that
   * accepted connections and never sent a body. Reticle held the evidence both times and the truth
   * was eventually established with `curl`.
   */
  pendingNavigationMs?: number;
  /**
   * Present only when the page's SDK version differs from the daemon's — see version-skew.ts.
   *
   * On the HEALTH block, not only on `reticle_sessions`, because skew causes SILENT action failures
   * and the fields it contradicts ride on the act result. Reported from the field: `act_and_wait`
   * returning `dispatched: true, settled: true, domMutatedWithin: 12-40ms` while React state never
   * changed, across eight attempts and three interaction strategies. The banner existed the whole
   * time — on `reticle_sessions` and `reticle_lease`, which is not the surface an agent reads on
   * every call.
   */
  versionSkew?: string;
}

/**
 * How long a request may be in flight before it is worth reporting on session health.
 *
 * A drive always has requests in the air, so a low bar puts a scary number on every healthy session
 * and trains agents to ignore the field — the same way a guard that fires on routine controls trains
 * them to pass `confirmDangerous` reflexively.
 *
 * 10s, and it is a HEURISTIC with no clean separation available: "a slow endpoint" and "a server
 * that will never answer" are the same observation until one of them finishes. The number is chosen
 * to sit between the two things actually measured, not derived from anything.
 *
 * Below it: this repo's own battery runs its API with `REFLECT_MS=6000` on purpose, and at the 5s
 * this first shipped with, a healthy app with one slow route was permanently non-nominal and carried
 * a scary number on every result.
 *
 * Above it: both reported wedges — 10.4s on one, 170s+ on the other. 10.4s clears this by 400ms,
 * which is thin, and an app with an 8-second endpoint will not be warned about a wedge until 10s.
 * That is the trade: an over-firing field gets ignored, and a field nobody reads catches nothing.
 */
export const PENDING_NAVIGATION_NOTICE_MS = 10_000;

/**
 * Said beside `dispatched` / `settled` on a skewed session, because those fields read as success.
 *
 * The reporter's own account of the cost: "the false-positive dispatch confirmation is what cost the
 * most time — I trusted `dispatched: true, domMutatedWithin: Nms` as real signal for a long time
 * before suspecting the skew banner." Stating the contradiction is the whole job here; the existing
 * banner was accurate and simply never appeared where it was needed.
 */
const SKEW_VERDICT_WARNING =
  'version skew: `dispatched` and `settled` on this session mean the event was sent, NOT that the ' +
  'app acted on it — a skewed pair drops actions silently. Re-read the control (aria-checked, ' +
  'data-state, its text) before trusting any verdict from this session, and converge the versions:';

/**
 * The age of the oldest request that STARTED and never completed, or undefined when there is none
 * worth reporting.
 *
 * Matched on request id, the way `detectHungRequests` and the route oracle's `unansweredIn` do: a
 * NET_PENDING with no NET_REQUEST carrying the same id. Three readings of one fact is two too many,
 * but they read different windows — this one is the whole session, which is the point: a wedge that
 * began before the current action is exactly the case a per-window reading cannot see.
 */
export function pendingNavigationMs(
  events: readonly ReticleEvent[],
  nowMs: number,
): number | undefined {
  const settled = new Set<unknown>();
  for (const e of events) if (e.type === EventType.NET_REQUEST) settled.add(e.data['id']);
  let oldest: number | undefined;
  for (const e of events) {
    if (e.type !== EventType.NET_PENDING || settled.has(e.data['id'])) continue;
    if (oldest === undefined || e.t < oldest) oldest = e.t;
  }
  if (oldest === undefined) return undefined;
  const age = nowMs - oldest;
  return age >= PENDING_NAVIGATION_NOTICE_MS ? age : undefined;
}

/** The evidence-completeness block spliced onto observe/network/console results. */
interface BufferEnvelope {
  buffer?: { held: number; dropped: number; note: string };
}

/**
 * Buffer-honesty envelope for observe/network/console. When the ring buffer has evicted anything
 * (age/size cap), a "no such event" answer may be a false negative — so we attach the drop count and
 * an actionable note. OMITTED entirely when nothing was dropped: silence means the buffer is intact,
 * so a clean/empty result there is trustworthy and costs zero tokens.
 */
export function bufferEnvelope(session: Session): BufferEnvelope {
  const { total, dropped } = session.bufferHealth();
  if (0 === dropped) return {};
  return { buffer: { held: total, dropped, note: BUFFER_EVICTION_WARNING } };
}

/** The `session` (and optional throttled `warning`) block spliced onto act/assert results. */
interface HealthEnvelope {
  session?: SessionHealth;
  warning?: string;
}

/**
 * Build the health envelope for a tool result. When the session is **nominal** (focused, not
 * throttled, no escape-hatch recommendation) the block is OMITTED entirely — a healthy session
 * conveys nothing actionable, and emitting it on every act/observe/assert call is pure token
 * overhead. The block (and a throttled `warning`) appears only when something is actually wrong,
 * so no health signal is lost — absence means healthy.
 */
export function healthEnvelope(session: Session): HealthEnvelope {
  const health = session.health();
  // A request stuck in flight makes a session non-nominal even when the tab is fine, because it is
  // the one condition where every observation is about to be about a page that is not moving.
  const nominal =
    !health.throttled &&
    health.focused &&
    health.recommendation === undefined &&
    health.pendingNavigationMs === undefined &&
    health.versionSkew === undefined;
  if (nominal) return {};
  // Skew outranks the throttle warning when both hold: a throttled tab makes a reading unreliable,
  // a skewed link makes the ACTION unreliable, and there is no point warning about the quality of an
  // observation of something that may never have happened.
  if (health.versionSkew !== undefined) {
    return { session: health, warning: `${SKEW_VERDICT_WARNING} ${health.versionSkew}` };
  }
  return health.throttled ? { session: health, warning: THROTTLED_WARNING } : { session: health };
}

/**
 * Opt-in hard stop. When `refuseWhenThrottled` is true and the tab is throttled, throw so the
 * agent does not drive a tab where timers/rAF/pointer gestures may silently no-op. Default is
 * warn-only so background testing never breaks.
 */
export function refuseIfThrottled(session: Session, refuse: unknown): void {
  if (true === refuse && session.throttled()) {
    throw new Error(`refusing to act: ${THROTTLED_WARNING}`);
  }
}

/**
 * The sentence appended to a FAILED predicate verdict waited out on a throttled tab.
 *
 * A starved tab and a missing element read identically as a bare near-miss: after a hard reload a
 * backgrounded tab can sit on its loading state forever (hydration starved, nothing painted), and
 * `wait_for { text }` timing out there looks exactly like "the code did not render" (#521). The
 * health envelope already rode alongside saying `throttled:true`, but nothing connected it to the
 * verdict an agent actually gates on. Appended, not replacing: the original diagnosis still leads,
 * and on a healthy tab the failure says exactly what it always said.
 */
const STARVED_WAIT_NOTE =
  ' (the tab was throttled during this wait, so starvation can look exactly like absence: bring it to the front and re-check before concluding this is genuinely missing)';

/**
 * Suffix the starvation note onto a FAILED predicate verdict when the tab is throttled. A pass is
 * returned untouched — starvation is context for a failure, not a reason to doubt a hold. Pure and
 * generic over the verdict shape so assert/wait_for/act_and_wait share one rule.
 *
 * The sentence FOLLOWS the field, and does not decide for itself. `annotateThrottledMiss`
 * (predicate.ts) owns the question of whether this failure was reached by not having seen
 * something, which is the only reading a starved tab casts doubt on; it stamps
 * `THROTTLED_STARVED_NOTE` when it was. Deciding again here got two answers to one question:
 * an `absent: true` assertion that MATCHED 13 elements was graded honestly in the field an agent
 * gates on, and told in prose that the tab may never have rendered. It also doubled up on a failure
 * that already carried a more specific reason (an unreadable locator, a superseded window), where
 * the concrete diagnosis is the one that should lead.
 */
export function annotateStarvedFailure<
  V extends { pass?: boolean; failureReason?: string; inconclusive?: string },
>(session: Session, verdict: V): V {
  if (true === verdict.pass || verdict.failureReason === undefined) return verdict;
  if (true !== session.throttled()) return verdict;
  if (THROTTLED_STARVED_NOTE !== verdict.inconclusive) return verdict;
  return { ...verdict, failureReason: `${verdict.failureReason}${STARVED_WAIT_NOTE}` };
}

/** The page's own visibility/runtime report, narrowed out of an untrusted PAGE_HEALTH payload. */
interface HealthReport {
  hidden: boolean | undefined;
  focused: boolean | undefined;
  runtime: string | undefined;
  /** Coarse rendering engine (blink/gecko/webkit) — context for a feedback report, not a health input. */
  engine: string | undefined;
  /**
   * Which browser the page is. Narrowed to `BrowserBrand` HERE rather than trusted: the SDK already
   * normalises, so anything else is a stale or hand-forged payload and is dropped — the point of the
   * closed list is that an unbounded string can never reach telemetry through it.
   */
  brand: BrowserBrand | undefined;
}

/**
 * Narrow a PAGE_HEALTH payload. Every field is optional on the wire — an older SDK does not report
 * `runtime` at all — so each is returned as undefined rather than defaulted here, letting the caller
 * keep its previous value instead of silently flipping a session to "visible" on a partial report.
 */
export function readHealthEvent(data: Record<string, unknown>): HealthReport {
  return {
    hidden: 'boolean' === typeof data['hidden'] ? data['hidden'] : undefined,
    focused: 'boolean' === typeof data['focused'] ? data['focused'] : undefined,
    runtime: 'string' === typeof data['runtime'] ? data['runtime'] : undefined,
    engine: 'string' === typeof data['engine'] ? data['engine'] : undefined,
    brand: Object.values(BrowserBrand).find((known) => known === data['brand']),
  };
}

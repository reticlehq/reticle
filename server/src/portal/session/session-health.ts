import {
  BrowserBrand,
  EventType,
  BUFFER_EVICTION_WARNING,
  THROTTLED_STARVED_NOTE,
  SESSION_HEALTH,
  THROTTLED_WARNING,
  type ReticleEvent,
} from '@reticlehq/core';
/**
 * What these functions need from a session, named structurally rather than imported.
 *
 * `Session` imports this module for `readHealthEvent`/`pendingNavigationMs`, so naming the class
 * here made a cycle out of three method signatures. The real `Session` satisfies this by having the
 * methods, and a test can now pass a two-line stand-in instead of a whole session.
 */
interface HealthSubject {
  bufferHealth(): { total: number; dropped: number };
  health(): SessionHealth;
  throttled(): boolean;
}

/** The health block spliced onto act/assert results. Defined here because this is what builds it. */
export interface SessionHealth {
  lastSeenMs: number;
  throttled: boolean;
  focused: boolean;
  /** present only when hidden/throttled — points at the `reticle drive` escape hatch. */
  recommendation?: string;
  /**
   * How long the OLDEST unanswered request has been in flight, when that is long enough to matter.
   *
   * Present only past `PENDING_NAVIGATION_NOTICE_MS`, so a healthy session costs nothing. Without
   * it, a fetch stuck pending forever and a dev server that accepts connections and never sends a
   * body both look exactly like an app that is merely slow — while the daemon holds the evidence.
   */
  pendingNavigationMs?: number;
  /**
   * Present only when the page's SDK version differs from the daemon's — see version-skew.ts.
   *
   * On the HEALTH block, not only on `reticle_sessions`, because skew causes SILENT action failures
   * and the fields it contradicts ride on the act result: `act_and_wait` can report `dispatched`,
   * `settled` and a DOM mutation while framework state never changed. A banner an agent only sees
   * on `reticle_sessions` or `reticle_lease` is not on the surface it reads every call.
   */
  versionSkew?: string;
  /**
   * The session's event ledger, once it has grown enough to be worth a reader's attention.
   *
   * Present only past `LEDGER_NOTICE_FRACTION` of the cap, so a healthy session costs nothing --
   * the same rule `pendingNavigationMs` follows. A ledger below that is doing its job quietly.
   *
   * It is here because nothing reported it. A repeating uncaught error wrote one session's ledger
   * at 13 MB/s for 14 hours and filled a 926 GB disk; neither the daemon nor `doctor` nor any
   * health counter said a word, and the user found out when the disk was full (#986). A cap bounds
   * the damage but does not make the writing visible, and this block is the surface an agent
   * already reads on every act and assert.
   */
  ledger?: { bytes: number; capBytes: number };
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
export function bufferEnvelope(session: HealthSubject): BufferEnvelope {
  const { total, dropped } = session.bufferHealth();
  if (0 === dropped) return {};
  return { buffer: { held: total, dropped, note: BUFFER_EVICTION_WARNING } };
}

/**
 * The session registered under `session.id` NOW, for describing a tab after a call that may have
 * replaced its document. A reload or full navigation registers a new Session under the same id, and
 * the object a handler resolved first is the page that unloaded; it reported itself hidden on the way
 * out, so its health said "throttled" about a tab that was fine. Optional-called because test doubles
 * are partial registries.
 */
export function currentOf<S extends { id: string }>(
  registry: { get?: (id: string) => S | undefined },
  session: S,
): S {
  return registry.get?.(session.id) ?? session;
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
export function healthEnvelope(session: HealthSubject): HealthEnvelope {
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
export function refuseIfThrottled(session: HealthSubject, refuse: unknown): void {
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
 * The note FOLLOWS the stamped field and does not decide for itself. `annotateThrottledMiss`
 * (predicate.ts) owns the question of whether this failure was reached by NOT HAVING SEEN
 * something, which is the only reading a starved tab casts doubt on, and stamps
 * `THROTTLED_STARVED_NOTE` when it was. Deciding again here gives two answers to one question: an
 * `absent: true` assertion that failed because it MATCHED elements is not in doubt, and must not be
 * told in prose that the tab may never have rendered. The same applies to a failure that already
 * carries a more specific reason (an unreadable locator, a superseded window): the concrete
 * diagnosis leads.
 */
export function annotateStarvedFailure<
  V extends { pass?: boolean; failureReason?: string; inconclusive?: string },
>(session: HealthSubject, verdict: V): V {
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

/**
 * The ledger block for the health payload, or nothing when it is not worth saying.
 *
 * Absent below `LEDGER_NOTICE_FRACTION` of the cap, and absent when the size has not been measured
 * yet -- a reader must be able to tell "not measured" from "empty", and a zero reported before the
 * first append would be a claim rather than a reading.
 */
export function ledgerNotice(ledger: { bytes: number; capBytes: number } | undefined): {
  ledger?: { bytes: number; capBytes: number };
} {
  if (ledger === undefined || 0 >= ledger.capBytes) return {};
  const fraction = ledger.bytes / ledger.capBytes;
  return fraction < SESSION_HEALTH.LEDGER_NOTICE_FRACTION ? {} : { ledger };
}

/**
 * Every health field that is present only when it means something.
 *
 * One place answers "which optional facts belong on the health block", so a session does not have
 * to know the rule for each. A healthy session gets an empty object back and its health block
 * carries only the fields that are always true.
 */
export function healthNotices(
  events: readonly ReticleEvent[],
  elapsed: number,
  ledger: { bytes: number; capBytes: number } | undefined,
): { pendingNavigationMs?: number; ledger?: { bytes: number; capBytes: number } } {
  // From event t=0, not a cursor: a wedge that began before the current action is exactly the case
  // a per-window reading cannot see, and is the one both reporters hit.
  const stuck = pendingNavigationMs(events, elapsed);
  return {
    ...(stuck === undefined ? {} : { pendingNavigationMs: stuck }),
    ...ledgerNotice(ledger),
  };
}

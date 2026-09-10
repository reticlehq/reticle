import { CHURN_TYPES, type ReticleEvent } from '@reticlehq/core';

/**
 * A self-budgeting hint returned on event-bearing tool results so the agent can decide whether to
 * narrow its next call (the report flagged 60KB+ results as a real token tax). `bytes` is the JSON
 * size of the payload; `droppedOldest` is present only when a cap actually truncated the timeline —
 * never a silent cap.
 */
interface CostHint {
  events: number;
  bytes: number;
  droppedOldest?: number;
  /** Present when the timeline is large — tells the agent to scope its NEXT call (cut tokens). */
  recommendation?: string;
}

/**
 * Above this, a timeline is big enough that re-reading it unscoped is a real token tax. Observed
 * live: a single login flooded 319 events / ~37KB because the dashboard's count-up animations emit
 * a dom.text per frame — the agent only dodged the cost by knowing to pass filters. The hint now
 * tells it.
 */
const LARGE_TIMELINE_EVENTS = 80;
const LARGE_TIMELINE_BYTES = 8000;

/**
 * Default cap for reticle_network / reticle_console when the caller passes no `limit`. Those tools
 * default `since` to 0 (the whole session), so a long-lived or event-flooded session produced an
 * UNBOUNDED result — a measured 1-hour flood is ~72,000 calls / ~1M tokens in a single tool result.
 * Capping to the most-recent N (with `total`/`droppedOldest` disclosed, so nothing is hidden and the
 * agent can page with since/until or a higher explicit limit) bounds the cost without changing the
 * window. 200 comfortably covers a real flow's traffic while killing the pathological case.
 */
export const DEFAULT_QUERY_LIMIT = 200;

/**
 * Default cap for `reticle_observe`'s timeline when the caller passes no `max_events`.
 *
 * Without one, the whole window is returned. That is fine for a quiet page and pathological for a
 * busy one: a page with count-up animations emits an event per frame, and a single observe result
 * was measured at ~60KB. The sibling tools (`reticle_network`, `reticle_console`) have had a default
 * for exactly this reason; observe was simply missed.
 *
 * Capping is safe for accuracy — and that is the only reason it is allowed. Contradiction detection
 * runs over the FILTERED-BUT-UNBUDGETED window (see `observe-tools.ts`), so a finding can never
 * disappear because the timeline was trimmed for tokens. What the cap changes is how much of the
 * timeline is printed, never what was examined.
 *
 * Nothing is hidden: whenever the cap bites, `cost.droppedOldest` says how many older events fell
 * outside it, and the caller can pass a larger `max_events` to see them.
 */
export const DEFAULT_OBSERVE_EVENT_LIMIT = 200;

/**
 * Trim a timeline to `maxEvents`, sacrificing noise before evidence.
 *
 * The obvious rule -- keep the most recent N -- is wrong here, and a live session showed why. A page
 * emits a health heartbeat every few seconds forever, so on any idle app the most recent events are
 * all heartbeats. A real observe call came back with 200 events and 46 KB whose own summary read:
 * zero network, zero DOM changes, zero route changes, zero console errors, zero signals. The budget
 * had been spent entirely on heartbeats, and the click the caller was asking about had been dropped
 * for being older.
 *
 * So evidence is kept first, and `CHURN_TYPES` -- which core already defines as the high-volume,
 * low-signal events that are "the ONLY thing that should be sacrificed when a buffer is full" -- is
 * used to fill whatever room is left. That rule already governed buffer eviction; it governs this
 * budget now too, so both agree on what is worth keeping.
 *
 * Order is preserved: the result reads oldest-first, like the timeline it came from.
 */
export function applyEventBudget(
  events: ReticleEvent[],
  maxEvents: number | undefined,
): { events: ReticleEvent[]; droppedOldest: number } {
  if (maxEvents === undefined || maxEvents < 0 || events.length <= maxEvents) {
    return { events, droppedOldest: 0 };
  }
  const isNoise = (event: ReticleEvent): boolean => CHURN_TYPES.has(event.type);
  const evidence = events.filter((event) => !isNoise(event));
  // Evidence alone can overflow the budget; then it is the most recent evidence that survives.
  const keptEvidence = evidence.slice(Math.max(0, evidence.length - maxEvents));
  const roomLeft = maxEvents - keptEvidence.length;
  const keptNoise = roomLeft <= 0 ? [] : events.filter(isNoise).slice(-roomLeft);
  const keep = new Set<ReticleEvent>([...keptEvidence, ...keptNoise]);
  return {
    events: events.filter((event) => keep.has(event)),
    droppedOldest: events.length - keep.size,
  };
}

/** Build a cost hint from a payload + the event count it carries. */
export function costHint(payload: unknown, events: number, droppedOldest = 0): CostHint {
  const json = JSON.stringify(payload) ?? '';
  // Actual UTF-8 wire bytes, not json.length (UTF-16 code units) — the field is labeled `bytes` and
  // drives the large-timeline recommendation, so a multibyte-heavy payload was under-counted.
  const bytes = Buffer.byteLength(json, 'utf8');
  const base: CostHint = droppedOldest > 0 ? { events, bytes, droppedOldest } : { events, bytes };
  if (events >= LARGE_TIMELINE_EVENTS || bytes >= LARGE_TIMELINE_BYTES) {
    base.recommendation = `large timeline (${String(events)} events, ~${String(estimateTokens(json))} tokens) — pass filters:[...] (e.g. ["signal","net"]) or max_events to scope your next call and cut tokens`;
  }
  return base;
}

/**
 * Rough token estimate for a string. The exact count is model/tokenizer-specific, but ~4 characters
 * per token is the well-known heuristic for English-ish text (and JSON) across GPT/Claude
 * tokenizers — accurate enough for the only decision it drives: "is this response big enough that I
 * should re-scope before reading it?" Deliberately a cheap, dependency-free approximation, NOT a
 * billing-grade count.
 */
const CHARS_PER_TOKEN = 4;
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * A size preview for non-event read results (snapshot, query). Same intent as CostHint but for
 * payloads measured by size rather than event count: the agent can bail and re-scope (mode:status,
 * a tighter scope, a more specific query) before spending context on a large body. The token
 * figure is an estimate (see estimateTokens).
 */
interface SizeCost {
  bytes: number;
  tokens: number;
}

export function sizeCost(payload: unknown): SizeCost {
  const json = JSON.stringify(payload) ?? '';
  // Actual UTF-8 wire bytes, not json.length (UTF-16 code units) — the field is labeled `bytes`
  // and drives the large-snapshot recommendation, so a multibyte-heavy payload was under-counted.
  const bytes = Buffer.byteLength(json, 'utf8');
  return { bytes, tokens: estimateTokens(json) };
}

/**
 * Attach a `cost` size preview to a read result. Pure: the cost is computed over the result BEFORE
 * the cost field is added (so it measures the body the agent will actually read), then merged in.
 * Non-object results (e.g. a thrown-error envelope) pass through unchanged.
 */
export function withSizeCost<T>(result: T): T {
  if (typeof result !== 'object' || null === result) return result;
  return { ...(result as Record<string, unknown>), cost: sizeCost(result) } as T;
}

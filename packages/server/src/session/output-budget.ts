import type { ReticleEvent } from '@reticle/protocol';

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

/** Keep only the most recent `maxEvents` events; report how many older ones were dropped. */
export function applyEventBudget(
  events: ReticleEvent[],
  maxEvents: number | undefined,
): { events: ReticleEvent[]; droppedOldest: number } {
  if (maxEvents === undefined || maxEvents < 0 || events.length <= maxEvents) {
    return { events, droppedOldest: 0 };
  }
  return {
    events: events.slice(events.length - maxEvents),
    droppedOldest: events.length - maxEvents,
  };
}

/** Build a cost hint from a payload + the event count it carries. */
export function costHint(payload: unknown, events: number, droppedOldest = 0): CostHint {
  const json = JSON.stringify(payload) ?? '';
  const bytes = json.length;
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
  return { bytes: json.length, tokens: estimateTokens(json) };
}

/**
 * Attach a `cost` size preview to a read result. Pure: the cost is computed over the result BEFORE
 * the cost field is added (so it measures the body the agent will actually read), then merged in.
 * Non-object results (e.g. a thrown-error envelope) pass through unchanged.
 */
export function withSizeCost<T>(result: T): T {
  if (typeof result !== 'object' || result === null) return result;
  return { ...(result as Record<string, unknown>), cost: sizeCost(result) } as T;
}

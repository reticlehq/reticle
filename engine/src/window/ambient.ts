import type { ReticleEvent } from '@reticlehq/core';

/**
 * Ambient-region learning. On a real-time app (chat, tickers, presence) whole DOM regions churn with
 * NO action driving them — an event with no `actionId`. Left unlearned, they make `settled` never fire
 * and flood every summary. This learns, per element ref, how often it churns ambiently; a ref past the
 * threshold is treated as ambient and excluded from the settle oracle, summaries, and envelopes. The
 * map is a learned, persisted per-app fact (like the contract) — confirmable, not silent.
 *
 * Global, not per-flow: the journal already sees the churn across every session, so the map sharpens
 * over time. Only UNATTRIBUTED churn counts — an event caused by an action is signal, never ambient.
 *
 * Deciding which changes on a page are background noise and which are the consequence of an action
 * is a judgement about what happened, so it lives with the rules that decide a verdict. Where the
 * learned map is kept between runs is a different question, and that part stayed in the journal.
 */

/** Per-region ambient churn counts. */
export type AmbientCounts = Record<string, number>;

/**
 * The identity ambient learning counts against. Prefer the emitted `region` (the stable CONTAINER of a
 * mutation) over the element ref: a churning feed appends a NEW element every tick (fresh ref) and a
 * removed element has no ref at all, so per-ref counts never accumulate and the region is never learned.
 * The container persists, so it is the only key that converges. Falls back to the ref for events that
 * mutate a single stable element (a ticker's text).
 */
export function ambientKeyOf(event: {
  ref?: string | undefined;
  data?: Record<string, unknown>;
}): string | undefined {
  const region = event.data?.['region'];
  if ('string' === typeof region && region.length > 0) return region;
  return event.ref;
}

/** A ref must churn ambiently at least this many times before it is treated as ambient. */
export const DEFAULT_AMBIENT_THRESHOLD = 20;

/**
 * An element ref: the letter `e` and a sequence number, minted per session by the SDK's ref table.
 *
 * It is an address within ONE session's numbering, not an identity. `e404` is whatever that session
 * happened to hand out 404th.
 */
const REF_SHAPED = /^e\d+$/;

/**
 * Is this ambient key meaningful in a DIFFERENT session?
 *
 * `regionKeyOf` prefers the nearest `data-testid` — a name the app chose, stable across every run —
 * and falls back to the element's ref when the region has none. Within a session that fallback is
 * correct and useful. Across one it is not merely useless, it is WRONG: the next session hands `e404`
 * to some other element, and the learned suppression lands on whatever that turns out to be.
 *
 * WHAT IT ACTUALLY AFFECTS. This map is read in exactly one place — the `settled` predicate drops
 * events on learned-ambient regions before deciding the page went quiet. So a poisoned map makes
 * `{kind: "settled"}` ignore regions that were never the churning ones, which is a false-green risk
 * in the settle oracle. It does NOT filter the windows that summaries or contradictions are computed
 * from; those read the buffer raw.
 *
 * That scope is narrower than this rule was first written as. The measurement offered for the wider
 * claim — DOM events reappearing once the file was cleared — was taken across a daemon restart and a
 * new session, so it did not isolate the file, and it is withdrawn. What stands without it: all 43
 * keys in the persisted map were ref-shaped, and a ref cannot mean anything in a session that did
 * not mint it.
 */
export function isStableAmbientKey(key: string): boolean {
  return !REF_SHAPED.test(key);
}

/** The counts worth carrying between sessions — the stable keys, and nothing else. */
export function onlyStableAmbient(counts: AmbientCounts): AmbientCounts {
  return Object.fromEntries(Object.entries(counts).filter(([key]) => isStableAmbientKey(key)));
}

/** Fold a batch of events into the running ambient counts. Only unattributed, ref-bearing events count. */
export function accumulateAmbient(
  counts: AmbientCounts,
  events: readonly ReticleEvent[],
): AmbientCounts {
  const next: AmbientCounts = { ...counts };
  for (const event of events) {
    if (event.actionId !== undefined) continue; // attributed to an action → signal, not ambient
    const key = ambientKeyOf(event);
    if (key === undefined) continue;
    next[key] = (next[key] ?? 0) + 1;
  }
  return next;
}

/** Whether a ref has churned ambiently often enough to be excluded from oracles/summaries. */
export function isAmbient(
  counts: AmbientCounts,
  ref: string | undefined,
  threshold: number = DEFAULT_AMBIENT_THRESHOLD,
): boolean {
  if (ref === undefined) return false;
  return (counts[ref] ?? 0) >= threshold;
}

/**
 * Drop events on learned-ambient regions — the exclusion the settle oracle and summaries apply. An
 * action-attributed event is ALWAYS kept, even on an ambient ref: if an action caused a change there,
 * it is signal, not background churn.
 */
export function excludeAmbient(
  counts: AmbientCounts,
  events: readonly ReticleEvent[],
  threshold?: number,
): ReticleEvent[] {
  return events.filter(
    (event) => event.actionId !== undefined || !isAmbient(counts, event.ref, threshold),
  );
}

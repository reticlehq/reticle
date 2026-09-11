import { z } from 'zod';
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

export const AmbientFileSchema = z.object({
  version: z.literal(1),
  regions: z.record(z.number()),
});

/** A ref must churn ambiently at least this many times before it is treated as ambient. */
export const DEFAULT_AMBIENT_THRESHOLD = 20;

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

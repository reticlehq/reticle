import type { IrisEvent } from '@syrin/iris-protocol';

/**
 * A self-budgeting hint returned on event-bearing tool results so the agent can decide whether to
 * narrow its next call (the report flagged 60KB+ results as a real token tax). `bytes` is the JSON
 * size of the payload; `droppedOldest` is present only when a cap actually truncated the timeline —
 * never a silent cap.
 */
export interface CostHint {
  events: number;
  bytes: number;
  droppedOldest?: number;
}

/** Keep only the most recent `maxEvents` events; report how many older ones were dropped. */
export function applyEventBudget(
  events: IrisEvent[],
  maxEvents: number | undefined,
): { events: IrisEvent[]; droppedOldest: number } {
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
  const bytes = JSON.stringify(payload)?.length ?? 0;
  return droppedOldest > 0 ? { events, bytes, droppedOldest } : { events, bytes };
}

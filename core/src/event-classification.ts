import { EventType } from './constants.js';

/**
 * The high-volume, low-signal floor. These fire continuously on any live page and are the ONLY
 * thing that should be sacrificed when a buffer is full. Everything else is scarce evidence a
 * verdict depends on. Shared by the browser transport queue and the server ring buffer so both
 * eviction policies agree on what to sacrifice.
 */
export const CHURN_TYPES: ReadonlySet<string> = new Set<string>([
  EventType.DOM_TEXT,
  EventType.ANIM_START,
  EventType.ANIM_END,
  EventType.RENDER_COMMIT,
  EventType.PAGE_HEALTH,
  EventType.SCROLL_POSITION,
]);

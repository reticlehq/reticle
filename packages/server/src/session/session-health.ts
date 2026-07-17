import { BUFFER_EVICTION_WARNING, THROTTLED_WARNING } from '@reticlehq/core';
import type { Session, SessionHealth } from './session.js';

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
  if (dropped === 0) return {};
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
  const nominal = !health.throttled && health.focused && health.recommendation === undefined;
  if (nominal) return {};
  return health.throttled ? { session: health, warning: THROTTLED_WARNING } : { session: health };
}

/**
 * Opt-in hard stop. When `refuseWhenThrottled` is true and the tab is throttled, throw so the
 * agent does not drive a tab where timers/rAF/pointer gestures may silently no-op. Default is
 * warn-only so background testing never breaks.
 */
export function refuseIfThrottled(session: Session, refuse: unknown): void {
  if (refuse === true && session.throttled()) {
    throw new Error(`refusing to act: ${THROTTLED_WARNING}`);
  }
}

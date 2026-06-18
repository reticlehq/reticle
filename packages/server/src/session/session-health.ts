import { THROTTLED_WARNING } from '@syrin/iris-protocol';
import type { Session, SessionHealth } from './session.js';

/** The `session` (and optional throttled `warning`) block spliced onto act/assert results. */
export interface HealthEnvelope {
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

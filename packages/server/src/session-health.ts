import { THROTTLED_WARNING } from '@iris/protocol';
import type { Session, SessionHealth } from './session.js';

/** F2: the `session` (and optional throttled `warning`) block spliced onto act/assert results. */
export interface HealthEnvelope {
  session: SessionHealth;
  warning?: string;
}

/** Build the health envelope for a tool result — adds a warning only when throttled. */
export function healthEnvelope(session: Session): HealthEnvelope {
  const health = session.health();
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

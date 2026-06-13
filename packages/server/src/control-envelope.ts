import { SessionState } from '@syrin/iris-protocol';
import type { Session } from './session.js';

/** Live-control: the control block spliced onto tool results so the agent sees human steering. */
export interface ControlEnvelope {
  state: SessionState;
  /** Drained inbox text, delivered to the agent exactly once. */
  guidance: string[];
}

/**
 * Build the piggyback control block for the agent's next tool result.
 *
 * Returns `undefined` iff the session is a CLEAN active one (state === ACTIVE AND inbox empty) —
 * i.e. there is nothing to tell the agent. Otherwise returns `{ state, guidance }`.
 *
 * DRAINS the inbox (the only read path) so a human message is delivered exactly once. Pure: it
 * reads no clock, so the piggyback is deterministic and unit-testable without a fake clock.
 */
export function buildControlEnvelope(session: Session): ControlEnvelope | undefined {
  const state = session.getState();
  const guidance = session.drainInbox().map((m) => m.text);
  if (state === SessionState.ACTIVE && guidance.length === 0) return undefined;
  return { state, guidance };
}

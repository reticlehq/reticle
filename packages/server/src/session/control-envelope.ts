import { SessionState } from '@syrin/iris-protocol';
import type { Session } from './session.js';

/** Live-control: the control block spliced onto tool results so the agent sees human steering. */
export interface ControlEnvelope {
  state: SessionState;
  /** Drained inbox text, delivered to the agent exactly once. */
  guidance: string[];
}

/**
 * Agent-readable hint returned when an action is refused mid-pause. Named, not free — the agent's
 * recovery path (address the guidance, then iris_resume) lives here in exactly one place.
 */
export const PAUSE_HINT =
  'Paused by the human. Address the guidance, then call iris_resume (or wait for the human to resume).';

/** Shape returned by the short-circuit when an action tool refuses while paused. */
export interface PausedResult {
  paused: true;
  guidance: string[];
  hint: string;
}

/** The optional `control` key `withControl` may add — keeps callers' return types honest. */
type ControlSpread = { control?: ControlEnvelope };

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

/**
 * PAUSE short-circuit. When the session is paused, drain the inbox and refuse the action so the
 * human's pause cannot be driven through. Returns undefined when the action may proceed.
 *
 * `drainInbox()` is the SOLE sink for guidance — draining here means the same message can never
 * also surface in a piggyback, guaranteeing delivered-once.
 */
export function pausedShortCircuit(session: Session): PausedResult | undefined {
  if (session.getState() !== SessionState.PAUSED) return undefined;
  return { paused: true, guidance: session.drainInbox().map((m) => m.text), hint: PAUSE_HINT };
}

/**
 * PIGGYBACK. Spread a `control` block onto a result object whenever the session is non-active OR
 * the inbox has messages (drained, so guidance is delivered exactly once). When the session is
 * clean (active + empty) nothing is added, keeping the result shape unchanged.
 */
export function withControl<T extends object>(session: Session, result: T): T & ControlSpread {
  const control = buildControlEnvelope(session);
  return control === undefined ? result : { ...result, control };
}

import { PresenterTone, SessionState } from '@syrin/iris-protocol';

/**
 * Build the args for a PRESENTER push. A session that auto-ended — the agent stopped or went idle —
 * rides a `warn` tone so the panel shouts "act now"; a normal human-driven transition stays calm.
 * Pure; the caller (Session.pushPresenter) owns the wire send.
 */
export function buildPresenterArgs(
  state: SessionState,
  text: string | undefined,
  autoEnded: boolean,
): Record<string, unknown> {
  const warn = state === SessionState.ENDED && autoEnded;
  return {
    state,
    ...(text !== undefined ? { text } : {}),
    ...(warn ? { tone: PresenterTone.WARN } : {}),
  };
}

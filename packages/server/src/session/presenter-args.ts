import { PresenterTone, SessionState } from '@reticlehq/protocol';

/**
 * Build the args for a PRESENTER push. An ended session can carry a `tone` so the panel tells apart
 * how the agent stopped — waiting (turn done), ask (needs you), warn (crashed) — from a calm "done".
 * Tone only rides an ended push; live transitions (active/paused) never carry one. Pure.
 */
export function buildPresenterArgs(
  state: SessionState,
  text: string | undefined,
  tone: PresenterTone | undefined,
): Record<string, unknown> {
  const carriesTone =
    state === SessionState.ENDED && tone !== undefined && tone !== PresenterTone.CALM;
  return {
    state,
    ...(text !== undefined ? { text } : {}),
    ...(carriesTone ? { tone } : {}),
  };
}

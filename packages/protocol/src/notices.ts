/**
 * Human-facing HUD/notice copy that crosses the wire to the panel or surfaces on tool results.
 * Kept apart from the wire enums in constants.ts so the prose can grow without bloating that file.
 */

/**
 * Tone of a PRESENTER push, rides the command as optional `tone`. Lets the panel tell apart the ways
 * a session can stop, so the human on the browser always knows the agent's mode:
 *   calm    — a normal, human/agent-driven end ("done").
 *   waiting — the agent finished its turn / went idle; it will resume on your next message.
 *   ask     — the agent is blocked and needs your input to continue (carries the question as text).
 *   warn    — the agent stopped unexpectedly (crashed / disconnected) — switch to your terminal.
 */
export const PresenterTone = {
  CALM: 'calm',
  WAITING: 'waiting',
  ASK: 'ask',
  WARN: 'warn',
} as const;
export type PresenterTone = (typeof PresenterTone)[keyof typeof PresenterTone];

/** Narrow an unknown wire value to a PresenterTone (defaults handled by the caller). */
export function isPresenterTone(value: unknown): value is PresenterTone {
  return (
    value === PresenterTone.CALM ||
    value === PresenterTone.WAITING ||
    value === PresenterTone.ASK ||
    value === PresenterTone.WARN
  );
}

/** Surfaced on act/assert results when the target tab is throttled. */
export const THROTTLED_WARNING =
  'tab throttled; timer/rAF/pointer gestures may silently no-op — refocus before driving';

/**
 * Pushed to the panel when the last agent's MCP connection drops — the agent (any of
 * Codex/OpenCode/Claude/Hermes) has stopped or is waiting on you. Tells the human, who is
 * on the browser, that control is back on the terminal so a typed prompt isn't silently lost.
 */
export const AGENT_STOPPED_NOTICE = 'Agent stopped — switch to your terminal to continue.';

/**
 * Prefixes any human notes typed into the panel but not yet read when the session ends — folded into
 * the end banner so a prompt sent in the death-race (agent stops mid-keystroke) is surfaced back to
 * the human, copyable, instead of vanishing into a dead inbox.
 */
export const UNDELIVERED_NOTES_LABEL = 'Undelivered (paste into your terminal):';

/** Panel notice when the agent yields after finishing its turn (iris_yield mode:'waiting'). */
export const AGENT_WAITING_NOTICE =
  'Agent finished its turn — your move. Continue in your terminal.';

/** Panel notice prefix when the agent is blocked on you (iris_yield mode:'ask'); the question follows. */
export const AGENT_ASK_NOTICE = 'Agent needs your input — answer in your terminal';

/**
 * Actionable companion to THROTTLED_WARNING. Surfaced on act/assert results and
 * iris_sessions rows when a tab is hidden/throttled and may be un-focusable/un-recoverable from
 * the in-page SDK + CDP path. Points at the `iris drive` escape hatch (a guaranteed scriptable
 * context). Iris cannot bring such a tab to front or recover it, so it names the limit instead.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION =
  'tab hidden/throttled and may be un-focusable from here; refocus it, or run `iris drive <url>` for a guaranteed scriptable context';

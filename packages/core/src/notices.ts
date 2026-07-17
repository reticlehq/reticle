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

/**
 * Surfaced on observe/network/console results once the event ring buffer has evicted anything (age
 * or size cap). Converts a silent false negative into an honest one: a "no such event" answer after
 * eviction may be "I dropped the evidence", not "it never happened" — widen the buffer / grade
 * sooner. Rides in a `buffer` block only when `dropped > 0` (silence ⇒ nothing lost).
 */
export const BUFFER_EVICTION_WARNING =
  'event buffer evicted older events (age/size cap) — a negative result here may be a false negative; the evidence may have expired. Grade sooner or widen the buffer.';

/**
 * Thrown when a tool needs a live browser session and none is connected. Names the #1 real cause in a
 * multi-repo / multi-agent setup — a PORT MISMATCH between the app's SDK and the daemon — so the agent
 * checks the wiring instead of only the "is the SDK enabled?" dead end.
 */
export const NO_SESSION_CONNECTED_ERROR =
  "no browser session connected. Two things to check: (1) your app is running with @reticlehq/browser enabled, and (2) it points at THIS daemon's port — a mismatch between the app's reticle({ port }) / VITE_RETICLE_WS_URL and the daemon's RETICLE_PORT is the usual cause. reticle_wait_ready blocks briefly for a session to appear.";

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

/** Panel notice when the agent yields after finishing its turn (reticle_yield mode:'waiting'). */
export const AGENT_WAITING_NOTICE =
  'Agent finished its turn — your move. Continue in your terminal.';

/** Panel notice prefix when the agent is blocked on you (reticle_yield mode:'ask'); the question follows. */
export const AGENT_ASK_NOTICE = 'Agent needs your input — answer in your terminal';

/**
 * Actionable companion to THROTTLED_WARNING. Surfaced on act/assert results and
 * reticle_sessions rows when a tab is hidden/throttled and may be un-focusable/un-recoverable from
 * the in-page SDK + CDP path. Points at the `reticle drive` escape hatch (a guaranteed scriptable
 * context). Reticle cannot bring such a tab to front or recover it, so it names the limit instead.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION =
  'tab hidden/throttled and may be un-focusable from here; refocus it, or run `reticle drive <url>` for a guaranteed scriptable context';

/**
 * Human-facing HUD/notice copy that crosses the wire to the panel or surfaces on tool results.
 * Kept apart from the wire enums in constants.ts so the prose can grow without bloating that file.
 */

/**
 * Tone of a PRESENTER push, rides the command as optional `tone`. Lets the panel tell apart the ways
 * a session can stop, so the human on the browser always knows the agent's mode:
 * calm — a normal, human/agent-driven end ("done").
 * waiting — the agent finished its turn / went idle; it will resume on your next message.
 * ask — the agent is blocked and needs your input to continue (carries the question as text).
 * warn — the agent stopped unexpectedly (crashed / disconnected) — switch to your terminal.
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
  'event buffer evicted older events (age/size cap): a negative result here may be a false negative; the evidence may have expired. Grade sooner or widen the buffer.';

/**
 * Thrown when a tool needs a live browser session and none is connected. Names the #1 real cause in a
 * multi-repo / multi-agent setup — a PORT MISMATCH between the app's SDK and the daemon — so the agent
 * checks the wiring instead of only the "is the SDK enabled?" dead end.
 */
export const NO_SESSION_CONNECTED_ERROR =
  "no browser session connected. Two things to check: (1) your app is running with @reticlehq/browser enabled, and (2) it points at THIS daemon's port — a mismatch between the app's reticle({ port }) / VITE_RETICLE_WS_URL and the daemon's RETICLE_PORT is the usual cause. reticle_wait_ready blocks briefly for a session to appear.";

/** Surfaced on act/assert results when the target tab is throttled. */
export const THROTTLED_WARNING =
  'tab throttled; timer/rAF/pointer gestures may silently no-op; refocus before driving';

/**
 * Prefixed onto a wait/assert miss when the session is throttled. A background tab is starved by
 * the browser, so a timeout there is not evidence the UI is absent — it may never have rendered.
 * `inconclusive` on the verdict (this string) is what stops that miss being graded as a product
 * failure. The CLI escape hatch is named second; an MCP-only agent has no shell.
 */
export const THROTTLED_STARVED_NOTE =
  'this tab is throttled and has not rendered; a miss here is not evidence the UI is absent. ' +
  'acquire a scriptable context with reticle_run { tool: "reticle_lease", action: "acquire", url } ' +
  '(the human can run `reticle drive <url>` if they have a shell)';

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
 * Returned by `reticle_session` yield/end when the turn ends with no browser session connected.
 *
 * Ending a turn is not an operation on a tab. The agent is reporting that it has stopped driving,
 * and that is true whether or not anything was ever connected — so refusing it made the agent fail
 * a call it was told is MANDATORY, on the most common state a session is in. Reported agents skip
 * yield entirely and note the gap in prose, which is the outcome this notice exists to remove.
 *
 * Said back to the caller rather than swallowed, so "the panel showed nothing" is a fact the agent
 * can put in its report instead of an absence it has to infer.
 */
export const YIELD_WITHOUT_SESSION_NOTE =
  'No browser session was connected, so there was no panel to update. The turn end was still ' +
  'recorded. If you expected an app to be attached, that is the thing to look into.';

/**
 * Actionable companion to THROTTLED_WARNING. Surfaced on act/assert results and
 * reticle_sessions rows when a tab is hidden/throttled and may be un-focusable/un-recoverable from
 * the in-page SDK + CDP path. Names the escape hatch the AGENT can take first (`reticle_lease`
 * through `reticle_run`, since lease is not on the default surface) and leaves `reticle drive` as
 * the human-side equivalent: an MCP-only agent has no shell, so a CLI sentence is advice it cannot
 * follow. Reticle cannot bring such a tab to front or recover it, so it names the limit instead.
 *
 * It also says what the escape hatch COSTS, and how sure the flag it fires on actually is. Both
 * were missing, and both omissions were reported from the field.
 *
 * A lease moves every later verdict into a pooled context the human cannot see, so following the
 * second half empties their HUD for the rest of the run and the product looks broken while working
 * correctly. A recommendation that names only the remedy reads as though it were free — and the
 * case where it is most expensive, a human sitting in front of the tab, is exactly the case where
 * refocusing was available.
 *
 * And `throttled` is not proof the tab cannot be driven: the reporter who raised this drove the
 * same throttled tab successfully afterwards. The flag was being read as a verdict because this
 * sentence offered a remedy for it. Saying the drive is worth trying first costs one clause and
 * stops the escape hatch being taken pre-emptively.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION =
  'tab hidden/throttled and may be un-focusable from here — though throttled does not mean undriveable, so trying the drive first is reasonable. If it fails: refocus the tab, or acquire a guaranteed scriptable context yourself with `reticle_run { tool: "reticle_lease", action: "acquire", url }` (a human can equivalently run `reticle drive <url>`). Leasing opens a context the human CANNOT watch — their HUD stays empty for the rest of the run — so prefer refocusing their tab if they are sitting in front of it.';

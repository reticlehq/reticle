/**
 * Human-facing HUD/notice copy that crosses the wire to the panel or surfaces on tool results.
 * Kept apart from the wire enums in constants.ts so the prose can grow without bloating that file.
 */

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
 * Actionable companion to THROTTLED_WARNING. Surfaced on act/assert results and
 * iris_sessions rows when a tab is hidden/throttled and may be un-focusable/un-recoverable from
 * the in-page SDK + CDP path. Points at the `iris drive` escape hatch (a guaranteed scriptable
 * context). Iris cannot bring such a tab to front or recover it, so it names the limit instead.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION =
  'tab hidden/throttled and may be un-focusable from here; refocus it, or run `iris drive <url>` for a guaranteed scriptable context';

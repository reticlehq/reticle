/**
 * Actionable error recovery. Every tool error the agent hits should answer "what do I do next?", not
 * just "what went wrong". This pure mapping turns a known error message into a concrete recovery hint
 * the agent (or the human, via the agent) can act on — so the first 5 minutes never dead-end on a
 * cryptic "no session connected". Spliced onto the error envelope at the MCP boundary (mcp.ts).
 *
 * Conservative by design: an unrecognized error returns `undefined` (no invented advice). Matching is
 * on stable, human-authored substrings of the thrown messages (see session-manager.ts, the flow/
 * baseline stores). No clock, no IO — unit-testable in isolation.
 */

/** The recovery hints, named so they are not free strings and can be asserted in tests. */
export const RECOVERY = {
  NO_SESSION:
    'No app is connected to Iris. Ask the human to start their app in dev with @syrin/iris-browser ' +
    'enabled, then run `iris status` to confirm a session appears. If the app is running but no ' +
    'session shows, the SDK is not reaching the bridge — check the dev server is up and using the ' +
    'configured Iris port.',
  MULTIPLE_SESSIONS:
    'Several tabs are connected. Call iris_sessions to list them, then pass an explicit sessionId to ' +
    'target the one you mean.',
  UNKNOWN_SESSION:
    'That sessionId is not connected. Call iris_sessions for the current ids and retry with a valid one.',
  THROTTLED:
    'The target tab is backgrounded/throttled, so actions may silently no-op. Ask the human to bring ' +
    'the tab to the front, or run `iris drive <url>` for a guaranteed scriptable context.',
  MISSING_BASELINE:
    'That baseline does not exist yet. Call iris_baseline_list to see saved names, or iris_baseline_save ' +
    'to capture one before diffing against it.',
  MISSING_RECORDING:
    'No recording by that name is in progress. Start one with iris_record_start before annotating, ' +
    'stopping, or saving it.',
  TOKEN_REQUIRED:
    'The bridge binds beyond localhost and requires a pairing token. Set the same token in the SDK ' +
    'init (@syrin/iris) and the Iris server config, then reconnect.',
} as const;

/** Ordered match rules; the first hit wins. Substrings track the thrown messages they recover. */
const RULES: readonly { readonly match: RegExp; readonly hint: string }[] = [
  { match: /no browser session connected/i, hint: RECOVERY.NO_SESSION },
  { match: /multiple sessions connected/i, hint: RECOVERY.MULTIPLE_SESSIONS },
  { match: /no connected session with id/i, hint: RECOVERY.UNKNOWN_SESSION },
  { match: /throttled|backgrounded/i, hint: RECOVERY.THROTTLED },
  { match: /no baseline named/i, hint: RECOVERY.MISSING_BASELINE },
  { match: /no (?:active|compiled) recording named/i, hint: RECOVERY.MISSING_RECORDING },
  { match: /pairing token is required/i, hint: RECOVERY.TOKEN_REQUIRED },
];

/** The actionable next move for a known error message, or undefined when none is recognized. */
export function recoveryFor(message: string): string | undefined {
  for (const rule of RULES) {
    if (rule.match.test(message)) return rule.hint;
  }
  return undefined;
}

/** The error envelope sent to the agent: the message, plus a recovery hint when one is known. */
interface ErrorPayload {
  error: string;
  recovery?: string;
}

/** Build the tool-error payload spliced at the MCP boundary — `recovery` is added only when known. */
export function buildErrorPayload(message: string): ErrorPayload {
  const recovery = recoveryFor(message);
  return recovery !== undefined ? { error: message, recovery } : { error: message };
}

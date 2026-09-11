/**
 * Classifying WHY a browser connection failed, into causes that each have a different fix.
 *
 * A raw error message cannot be sent — it carries CDP URLs, executable paths, and home directories —
 * and would be useless if it could, because the same cause arrives worded five different ways from
 * Playwright, Node and the OS. What we need is the small set of THINGS THAT ACTUALLY GO WRONG:
 * a missing browser binary is a docs problem, a refused CDP endpoint is a configuration problem, a
 * pool timeout is a capacity problem. Three very different responses from us.
 *
 * `OTHER` is the bucket to watch. A large `OTHER` count means the classifier has a blind spot and
 * this list needs another entry — which is a signal in itself, and the reason it is never merged
 * into one of the known causes.
 */
import { ConnectFailure } from '@reticlehq/core/telemetry';

/** Ordered most-specific first; the first match wins. Patterns track messages we have actually seen. */
const RULES: readonly { readonly match: RegExp; readonly cause: ConnectFailure }[] = [
  // Playwright's own wording when the browser was never downloaded.
  {
    match: /executable doesn.?t exist|playwright install|browsertype\.launch/i,
    cause: ConnectFailure.CHROMIUM_MISSING,
  },
  {
    match: /cannot find module ['"]?playwright|playwright is not installed/i,
    cause: ConnectFailure.PLAYWRIGHT_MISSING,
  },
  {
    match: /econnrefused|connect over cdp|websocket error|failed to connect|enotfound|etimedout/i,
    cause: ConnectFailure.CDP_UNREACHABLE,
  },
  {
    match: /target (?:page|closed)|browser has been closed|browser has disconnected|crashed/i,
    cause: ConnectFailure.BROWSER_CRASHED,
  },
  { match: /pool|lease.*timed out|timed out waiting/i, cause: ConnectFailure.POOL_TIMEOUT },
];

/** The cause behind a connection error, or `OTHER` when we do not recognize it. */
export function classifyConnectFailure(error: unknown): ConnectFailure {
  const message = error instanceof Error ? error.message : String(error);
  for (const rule of RULES) {
    if (rule.match.test(message)) return rule.cause;
  }
  return ConnectFailure.OTHER;
}

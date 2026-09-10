/**
 * "The page reconnected under the same id" — one sentence, and one way to recognise it.
 *
 * A server-rendered app reconnects its SDK on EVERY full page load, so on an MPA this is the normal
 * consequence of following a link, not a fault. The bridge rejects any command that was in flight
 * when it happens, and a caller that reads that rejection as fatal cannot walk past the first link:
 * reported against `reticle_verify action=crawl`, which died on link one of every Django, Rails and
 * plain-HTML app.
 *
 * The prefix lives here so the producer and the predicate cannot drift apart. This repo has already
 * shipped that exact bug twice — a remedy string restated in a second place, and a redaction name
 * derived two different ways — and both times the halves disagreed silently.
 */

/** The start of the reason the bridge hands to commands displaced by a reconnect. */
export const SESSION_REPLACED_PREFIX = 'session replaced by a newer connection';

/** Build the full reason. The only place this sentence is written. */
export function sessionReplacedReason(id: string, url: string): string {
  return `${SESSION_REPLACED_PREFIX} claiming the same id (${id}) from ${url}`;
}

/**
 * Was this failure a reconnect rather than a fault?
 *
 * Accepts the thrown value rather than a string so every call site can hand over whatever it caught
 * without each one re-deriving a message — an `Error`, a bare string, or something else entirely.
 */
export function isSessionReplacedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(SESSION_REPLACED_PREFIX);
}

/**
 * Say that the look HAPPENED, when the look found nothing.
 *
 * A quiet page and a dead observer produce the same JSON: `[]`. Reported across seven tools in a
 * field sweep — network with 0 calls, console with 0 logs, reconcile comparing 0, crawl with 0 steps,
 * an empty message inbox — none of which could be told apart from the observer not working. Those
 * need opposite responses: one means "the app did nothing", the other means "stop trusting this run".
 *
 * One shared shape rather than a field per tool: an empty read states the window it watched. "I
 * watched 2000ms and saw nothing" is a finding. `[]` is an absence of information wearing the same
 * clothes as one.
 */

interface EmptyReadContext {
  /** The observation window, when the read has one. */
  windowMs?: number;
  /** What was being counted, in the agent's words: "console lines", "network calls". */
  noun: string;
  /**
   * What this channel could NOT have seen, when it has a structural blind spot.
   *
   * "The observation ran and found none" is only the whole truth for a channel that was watching
   * the entire window. The console is not one: it does not exist until the SDK patches it, so a
   * clean read cannot speak for what the page logged before that. Saying so here is the difference
   * between a result and a confident false green — omitted for every channel that has no such gap.
   */
  caveat?: string;
}

/**
 * Add `observed: true` and a note when `key` holds an EMPTY array. Returns the result untouched
 * otherwise — including when it is a refusal, where "I observed nothing" would be actively
 * misleading on top of an error that already explains itself.
 */
export function noteEmptyRead(
  result: Record<string, unknown>,
  key: string,
  context: EmptyReadContext,
): Record<string, unknown> {
  if ('string' === typeof result['error']) return result;
  const value = result[key];
  if (!Array.isArray(value) || value.length > 0) return result;
  if (result['note'] !== undefined) return result;
  const window =
    context.windowMs === undefined ? '' : ` over the last ${String(context.windowMs)}ms`;
  return {
    ...result,
    // The distinction the field sweep could not make: this is a RESULT, not a failure to look.
    observed: true,
    note:
      `no ${context.noun}${window}; the observation ran and found none, which is a result, not a missing reading` +
      (context.caveat === undefined ? '' : ` — ${context.caveat}`),
  };
}

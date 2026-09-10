/**
 * Telling the reporter that a BACKGROUND feedback delivery failed.
 *
 * The agent's `reticle_feedback` no longer waits for the POST — a ~340ms network round-trip on the
 * one call an agent makes mid-task is the product blocking the user's work to talk about itself. But
 * not waiting reopens the exact hole the awaited version was written to close: `sent` used to be
 * unconditional, so a DNS miss and a 4xx both reported "filed", and this is the ONLY qualitative
 * channel the product has. A lost report that was announced as filed is worse than no channel.
 *
 * So the wait goes and the honesty stays: the receipt says ACCEPTED (validated, redacted, queued),
 * never "delivered", and if the send then fails the agent is told on its next tool result through
 * the same one-shot envelope the update and skew nudges use. Told once — a reporter who cannot fix
 * the network does not need it repeated, and a banner on every call is one agents learn to skip.
 */

/** Set when a background feedback send failed and the reporter has not been told yet. */
let pending: string | undefined;

/** Record that a queued report never made it. */
export function noteFeedbackUndelivered(reason: string): void {
  pending = reason;
}

/** The undelivered-feedback notice, once. */
export function takeFeedbackUndelivered(): string | undefined {
  const notice = pending;
  pending = undefined;
  return notice;
}

/** Tests only — drop the module state so each case starts clean. */
export function resetFeedbackDelivery(): void {
  pending = undefined;
}

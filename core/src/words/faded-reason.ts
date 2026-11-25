/**
 * The words that start an `unreadable` reason when the composed opacity hides the text.
 *
 * `@reticlehq/browser` writes the reason and `@reticlehq/engine` reads it back to add advice. The two
 * packages do not import each other, so the prefix lives here and both sides use it.
 */
export const FADED_REASON_PREFIX = 'the composed opacity is';

/** The reason the browser gives for text hidden by opacity. The opacity follows, to two decimals. */
export function fadedReason(opacity: number): string {
  return `${FADED_REASON_PREFIX} ${opacity.toFixed(2)}`;
}

/** True when a reason says that opacity hid the text. */
export function isFadedReason(reason: string): boolean {
  return reason.includes(FADED_REASON_PREFIX);
}

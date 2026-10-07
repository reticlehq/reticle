/**
 * Arguments of the `match` command beyond its `query` and `state`.
 *
 * Kept apart from `constants.ts`, which sits at its line cap: this is one small group with a reader
 * on each side of the wire, and nothing else in that file depends on it.
 *
 * The display form of an element's text is 80 characters and an ellipsis (`MAX_DESCRIBED_TEXT`),
 * which is right for output an agent reads and wrong for a verdict: it fails an exact `oneOf` or an
 * end-anchored pattern on anything longer. A verdict asks for `FULL_TEXT`, and the page answers with
 * up to `MAX_FULL_TEXT` characters for at most `MAX_FULL_TEXT_ELEMENTS` elements. Both are bounded
 * because the transport spends ONE budget of `MAX_MESSAGE_BYTES / 4` characters per response and
 * silently replaces the overflow; 32 elements of 4000 characters is about half of it, leaving the
 * rest for every other descriptor field. `count` still reports every match, and a text cut at the
 * bound is `MAX_FULL_TEXT` characters plus an ellipsis, so only a cut text is ever longer than it.
 */
export const MatchArg = {
  /** `true` describes each match with up to `TRANSPORT_LIMITS.MAX_FULL_TEXT` characters of text, not the display-sized 80. */
  FULL_TEXT: 'fullText',
} as const;

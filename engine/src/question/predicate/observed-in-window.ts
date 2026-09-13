/**
 * What DID happen, when the thing you asserted did not.
 *
 * "signal 'x' never fired" and "no matching network call" are true and useless: a typo'd name and a
 * genuinely broken app produce the same sentence, and the agent cannot tell them apart without a
 * round trip it does not know to make. `{ kind:'state' }` already answers a bad path by naming the
 * stores that exist; this gives `signal` and `net` the same courtesy.
 *
 * It also distinguishes the two failures that matter: NOTHING happened in the window (the action did
 * not do what you thought) versus things happened but not that one (you named it wrong).
 */

/** Enough to recognise the one you meant; not so many that a chatty window floods the message. */
const MAX_LISTED = 8;

export function describeObserved(noun: string, seen: readonly string[]): string {
  const unique = [...new Set(seen.filter((s) => s.length > 0))];
  if (0 === unique.length) return `no ${noun} at all in this window`;
  const shown = unique.slice(0, MAX_LISTED);
  const rest = unique.length - shown.length;
  return `${noun} seen in this window: ${shown.join(', ')}${rest > 0 ? `, and ${String(rest)} more` : ''}`;
}

/**
 * The third answer, and the one this file existed to make room for: things happened, and they belong
 * to a document that has since been replaced.
 *
 * `describeObserved` already separates "nothing happened" from "things happened but not that one",
 * because those need different fixes. A window whose evidence was discarded as superseded is a third
 * case needing a third fix, and it is the one that reads most like the first: everything that could
 * have answered the question is gone, so a bare "nothing happened in this window" is available and
 * wrong. The remedy is in the sentence, because an agent that cannot act on a caveat learns to skip
 * it — here the remedy is to drive the action again against the page now on screen.
 */
export function describeSuperseded(noun: string, count: number): string {
  return (
    `no ${noun} belong to the document currently on screen: ${String(count)} ${noun} were observed ` +
    `and every one of them belongs to a document that has since been replaced (the page reloaded or ` +
    `navigated). This says nothing about the app — the evidence went away with the page that produced ` +
    `it. Re-drive the action against the page now on screen`
  );
}

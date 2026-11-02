/** What the rule needs to know about an event. The caller supplies it, so this file reads no wire shape. */
interface AppReaction<E> {
  /** Which store path or signal the event moved, or undefined when it moved neither. */
  keyOf: (event: E) => string | undefined;
  /** Whether the caller's predicate named this change. */
  isNamed: (event: E) => boolean;
}

/**
 * A store change or an app signal that can be TIED to the action (#1531).
 *
 * The app's own state moving is a reaction, the same as a request, even when the DOM update it
 * drives lands after the window was read: a Pause button whose store changes on the media `pause`
 * event. But being in the window is not enough. The session stamps the active action's id on every
 * event between dispatch and settle, so a busy page's background store updates look attributed
 * too, and a dead click among them must still be reported ("no-effect under ambient churn").
 *
 * So a change counts only when it is tied to the action in one of two ways:
 *  - the caller's predicate named it (a `state` path or a `signal` name), so it is the consequence
 *    they expected; or
 *  - it was quiet before the action: `prior` holds observations, and none of them moved this path
 *    or fired this signal. Churn that was already moving is the background, not this click.
 */
export function tiedReaction<E>(
  prior: readonly E[],
  { keyOf, isNamed }: AppReaction<E>,
): (event: E) => boolean {
  const movedBefore = new Set<string>();
  for (const event of prior) {
    const key = keyOf(event);
    if (key !== undefined) {
      movedBefore.add(key);
    }
  }
  return (event) => {
    const key = keyOf(event);
    if (key === undefined) {
      return false;
    }
    return isNamed(event) || (prior.length > 0 && !movedBefore.has(key));
  };
}

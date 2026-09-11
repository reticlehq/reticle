/**
 * The "…but that role IS carrying this label" clause on a failed element predicate.
 *
 * `reticle_query` answers a role+name miss with `hint.nameNearMiss` -- the labels that role really
 * has, when one of them is a containment away from the one asked for. A failed PREDICATE had no
 * equivalent: `no element matched {role: "button", name: "Mesh"}` is byte-identical for a page with
 * no such button and for one showing `button "2 Mesh"`, and only one of those is a bug (#875).
 *
 * That asymmetry is the same one `describeSplitTextMiss` was written to close one field over: the
 * identical failure through `reticle_query` listed what IS present while the predicate path was a
 * dead end. The browser already computes this on its way to reporting zero, so the clause costs
 * nothing but the sentence.
 *
 * Undefined when there is nothing to say, for the reason every clause in this family is: one that
 * fires on every failure stops carrying information.
 */

/** Enough of a label to recognise it; this is read in a verdict, not a log. */
const MAX_NAME = 60;

/** At most this many alternatives in one sentence -- beyond that it is a result set, not a hint. */
const MAX_NAMED = 3;

function truncate(value: string): string {
  return value.length > MAX_NAME ? `${value.slice(0, MAX_NAME)}…` : value;
}

/**
 * The clause, or undefined when the page carried no near-miss label.
 *
 * `role` is named in the sentence because the hint is scoped to it: the browser will not offer a
 * link called "2 Mesh" as a recovery for a BUTTON called "Mesh", and the message should not read as
 * if it might have.
 */
export function describeNameNearMiss(
  near: readonly string[] | undefined,
  searchedName?: string,
  role?: string,
): string | undefined {
  if (near === undefined || 0 === near.length) return undefined;
  const labels = near.slice(0, MAX_NAMED).map((name) => JSON.stringify(truncate(name)));
  const asked = searchedName === undefined ? 'that name' : JSON.stringify(truncate(searchedName));
  const what = role === undefined ? 'the page has' : `the page's ${role}s include`;
  return (
    `role+name matching is EXACT and nothing is named ${asked}, but ${what} ${labels.join(', ')} — ` +
    're-query with the full name rather than a substring of it'
  );
}

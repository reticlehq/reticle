/**
 * The coverage number that counts what a run never touched.
 *
 * `steps`/`declared` measure how much of what a run DROVE it actually proved — both go up when the
 * suite gets more rigorous about the routes it already visits, and neither ever notices a route no
 * flow goes near. A perfect score on two of eleven routes is not a green app, and nothing else here
 * says so.
 *
 * Known routes are what the app has been SEEN to have, accumulated across runs, so this is the one
 * figure that grows by exploring rather than by writing more assertions.
 */
export function unreachedRoutes(known: readonly string[], visited: readonly string[]): string[] {
  const seen = new Set(visited);
  const out: string[] = [];
  for (const route of known) {
    // A route visited but never learned is not a gap — it is the opposite, so only `known` is walked.
    if (seen.has(route)) continue;
    if (out.includes(route)) continue;
    out.push(route);
  }
  return out;
}

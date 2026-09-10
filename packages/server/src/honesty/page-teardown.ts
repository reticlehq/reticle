/**
 * How we say that a page went away while it was on a particular address.
 *
 * Two different surfaces tell a person about the same event. The verdict says a consequence could
 * not be checked because the page disappeared; the setup diagnosis says why no session is connected.
 * If each wrote its own sentence they would eventually describe the same teardown in two ways, and
 * whoever read both would go looking for two problems.
 *
 * It lives beside the rules that decide a verdict rather than beside the diagnosis, because the
 * rules are meant to be liftable on their own. Anything they need has to come with them.
 *
 * Example: `pageTornDownWhileOn('http://localhost:3000/checkout')` gives
 * "the page was torn down while on http://localhost:3000/checkout".
 */
export function pageTornDownWhileOn(url: string): string {
  return `the page was torn down while on ${url}`;
}

/**
 * Is the thing on this port a DEV SERVER serving the app, or just something on a port?
 *
 * The probe used to answer "something accepted a TCP connection", which on macOS means every Mac
 * reports Apple's AirPlay Receiver on port 5000 as the user's dev server. Reproduced here: it
 * answers `HTTP/1.1 403 Forbidden`, `Server: AirTunes/950.7.1`, no body. The agent was then told
 * "something IS listening on port 5000 and this project is wired for Reticle" while the app was on
 * 3100 — a diagnostic confidently naming a service with nothing to do with the project.
 *
 * A dev server serving an app answers `GET /` with a document. That is the whole test. A false
 * negative costs a less specific message; a false positive costs trust in every diagnostic Reticle
 * prints, which is far more expensive.
 */

/** Statuses that mean "I will not serve you", which no local dev server does for its own app root. */
const REFUSES = new Set([401, 403, 407]);

export function looksLikeDevServer(status: number, contentType: string | undefined): boolean {
  if (REFUSES.has(status)) return false;
  // A redirect IS a server routing: a dev server on a base path answers `/` with one.
  if (status >= 300 && status < 400) return true;
  // Otherwise it has to be serving a document. A 404 that renders HTML is still a dev server — the
  // server is there, only the route is missing.
  return contentType !== undefined && contentType.toLowerCase().includes('text/html');
}

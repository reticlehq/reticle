/**
 * The probe reported Apple's AirPlay Receiver as the user's dev server.
 *
 * Reported from the field, and reproduced on this machine: macOS ControlCenter listens on port 5000
 * by DEFAULT on every Mac. The probe did a bare TCP connect, saw it accept, and told the agent
 *
 *   "no browser session connected, but something IS listening on port 5000 and this project is
 *    wired for Reticle — ..."
 *
 * while the app under test was on 3100. A diagnostic that confidently names the wrong thing is worse
 * than no diagnostic: it sends the agent to investigate a service that has nothing to do with the
 * project, and it fires for every Mac user.
 *
 * What port 5000 actually answers here:
 *
 *   HTTP/1.1 403 Forbidden
 *   Content-Length: 0
 *   Server: AirTunes/950.7.1
 *
 * So "something accepted a TCP connection" is not the question. The question is "is a dev server
 * serving this app here", and a dev server answers `GET /` with a document. A false negative costs
 * only a less specific message; a false positive costs the agent's trust in every diagnostic.
 */

import { describe, expect, it } from 'vitest';
import { looksLikeDevServer } from './looks-like-dev-server.js';

describe('what counts as a dev server', () => {
  it('accepts an HTML document — every dev server serves one at the app root', () => {
    expect(looksLikeDevServer(200, 'text/html; charset=utf-8')).toBe(true);
  });

  it('rejects AirPlay: a 403 with no content type', () => {
    expect(looksLikeDevServer(403, undefined)).toBe(false);
  });

  it('rejects anything that refuses the request', () => {
    for (const status of [401, 403, 407])
      expect(looksLikeDevServer(status, 'text/html')).toBe(false);
  });

  it('rejects a service that answers but serves no document', () => {
    // A JSON API, a metrics endpoint, a database admin port — none of these is the app.
    expect(looksLikeDevServer(200, 'application/json')).toBe(false);
    expect(looksLikeDevServer(200, undefined)).toBe(false);
  });

  it('accepts a redirect, which a dev server behind a base path does', () => {
    expect(looksLikeDevServer(302, undefined)).toBe(true);
  });

  it('accepts a 404 that still serves HTML — a dev server with no route at /', () => {
    // The server IS there and rendering; only the route is missing.
    expect(looksLikeDevServer(404, 'text/html')).toBe(true);
  });

  it('rejects a 404 with no document — that is just something on a port', () => {
    expect(looksLikeDevServer(404, undefined)).toBe(false);
  });
});

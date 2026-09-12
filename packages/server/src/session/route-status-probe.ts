/**
 * What does the route a tab died on answer right now?
 *
 * A route that throws server-side tears the page down and the SDK never reconnects, so the daemon
 * is left with an empty session list and the URL it last saw (#862). The URL alone cannot separate
 * "the route 500s" from "somebody closed the tab" — one plain GET can, and the daemon is the only
 * party placed to make it: the page is gone, the agent is inside an MCP call, and the daemon is on
 * the same machine as the dev server.
 *
 * What it refuses to do, because this runs unattended in a diagnostic loop:
 *   - only loopback hostnames — the daemon is localhost-only and a diagnostic must not reach out;
 *   - only `http:` — `https:` on localhost means a self-signed certificate, and fetching it with
 *     verification off would be a posture change for a status code;
 *   - GET only, redirects not followed, the body never read — the status is the only thing that
 *     leaves the socket, and it is drained so the connection closes rather than lingers;
 *   - an error or a timeout is `undefined`, never a status. No fact is better than a wrong one.
 *
 * Same shape as `dev-server-probe.ts`, which asks a port whether it serves a document; this asks
 * one exact path what it answers.
 */

import { request } from 'node:http';
import { isLoopbackHostname } from '@reticlehq/core';

/** Short on purpose: a dev server that has not answered a route in this long is not going to. */
export const ROUTE_STATUS_TIMEOUT_MS = 2_000;

const HTTP = 'http:';

/** The HTTP status `url` answers a GET with, or undefined when there is no answer to report. */
export function probeRouteStatus(
  url: string,
  timeoutMs: number = ROUTE_STATUS_TIMEOUT_MS,
): Promise<number | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(undefined);
  }
  if (parsed.protocol !== HTTP || !isLoopbackHostname(parsed.hostname)) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const req = request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode;
        res.resume(); // drain, so the socket closes rather than lingering
        resolve(status);
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.once('error', () => resolve(undefined));
    req.end();
  });
}

/**
 * Which of the usual dev-server ports have something listening on them.
 *
 * The one fact that separates "the app is not running" from "the app is running and never dialled
 * us" — the difference between two completely different next actions for the agent, which the
 * no-session message could not tell apart before. See no-session-diagnosis.ts.
 *
 * Kept out of the hot path: `SessionManager.resolve` is synchronous and runs on every tool call, so
 * the probe refreshes in the background and the resolve path reads a cached answer. A stale answer
 * is fine here — it is a hint in an error message, not a decision.
 */

import { request } from 'node:http';
import { DEV_SERVER_PORTS } from '../cli/cli-port.js';
import { looksLikeDevServer } from './looks-like-dev-server.js';

/**
 * How long to wait for `GET /` before treating the port as empty.
 *
 * This used to be 400ms, on the reasoning that an answer from localhost either lands quickly or
 * nothing is there. That is true of a served file and false of the first request to a dev server:
 * Vite, Next and Nuxt compile the entry route on demand, and the first hit after boot routinely
 * takes over a second. The probe gave up, `listening` came back empty, and the no-session message
 * told an agent nothing was listening while a Nuxt server answered on :5000 — the same conclusion
 * as an empty port, drawn from evidence that is nothing like it.
 *
 * The ports are probed with `Promise.all`, so this is the cost of the slowest port rather than the
 * sum, and it is paid on a background refresh that nothing waits on. Buying a real answer for a
 * compiling dev server is worth more than the latency.
 */
const HTTP_PROBE_TIMEOUT_MS = 2000;
/**
 * `localhost`, not `127.0.0.1` — so BOTH address families are tried.
 *
 * Measured: a plain `vite --port 4311` on this machine listens on `[::1]` only, and a probe pinned to
 * the IPv4 loopback cannot see it. The old TCP probe had the same blind spot, which meant the
 * diagnostic could miss the very dev server it exists to find while still reporting an unrelated
 * service that happens to bind both stacks (macOS AirPlay does).
 *
 * This also covers the wildcard binds a `--host` dev server uses. Measured on Windows against a
 * server on `0.0.0.0:5199`: `localhost` connects, `::1` is refused. Node tries both families for a
 * name that resolves to several (`autoSelectFamily`, on by default from Node 20, and this package
 * requires >= 20), so the loopback failure does not end the attempt. dev-server-probe.test.ts pins
 * `0.0.0.0` and `::` so that a future switch back to a pinned address fails loudly rather than
 * silently reintroducing the blind spot.
 */
const PROBE_HOST = 'localhost';

/**
 * Does this port serve a DOCUMENT — i.e. is it a dev server rather than merely something listening?
 *
 * A bare TCP connect reported macOS ControlCenter (AirPlay Receiver, on by default on every Mac,
 * port 5000) as the user's dev server. See looks-like-dev-server for what it actually answers and
 * why "a socket accepted" is the wrong question.
 */
function servesDocument(port: number, host = PROBE_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path: '/', method: 'GET', timeout: HTTP_PROBE_TIMEOUT_MS },
      (res) => {
        const answer = looksLikeDevServer(res.statusCode ?? 0, res.headers['content-type']);
        res.resume(); // drain, so the socket closes rather than lingering
        resolve(answer);
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.once('error', () => resolve(false));
    req.end();
  });
}

/** Every candidate port serving a document, in ascending order. Never rejects. */
export async function probeDevServers(
  ports: readonly number[] = [...DEV_SERVER_PORTS],
  probe: (port: number) => Promise<boolean> = (p) => servesDocument(p),
): Promise<number[]> {
  const results = await Promise.all(ports.map((p) => probe(p).then((up) => (up ? p : null))));
  return results.filter((p): p is number => p !== null).sort((a, b) => a - b);
}

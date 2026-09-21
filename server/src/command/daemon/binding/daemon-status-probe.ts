import * as http from 'node:http';
import { LOOPBACK_HOST, STATUS_PATH } from '@reticlehq/core';
import { loopbackAgent } from '@/surface/loopback-agent.js';

/**
 * The impure half of `probePresence`: ask the port whether a Reticle daemon is answering.
 *
 * It lives beside `port-presence.ts` rather than in `launch/` because every caller of
 * `probePresence` passes it — status, doctor, kill, verify, drive, the daemon lifecycle and the
 * MCP wake path all spell `probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus })`.
 * Filed under `launch/` it read as a launcher helper, and it is not one; the proxy could not reach
 * it there without inventing a dependency on a directory it has no other business with.
 *
 * The rule it feeds stays pure and socket-free in `port-presence.ts`. That split is deliberate: a
 * probe that starts lying is a different failure from a rule that does.
 */

/** How long the daemon /status probe waits before giving up — a local loopback call is near-instant. */
const STATUS_PROBE_TIMEOUT_MS = 1000;

/** GET the daemon's /status JSON. Resolves to the parsed body, or undefined on any failure. */
export function fetchStatus(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: LOOPBACK_HOST,
        port,
        path: STATUS_PATH,
        timeout: STATUS_PROBE_TIMEOUT_MS,
        // Shares the proxy's keep-alive agent: the proxy calls this on every reconnect, and a socket
        // per probe is the same churn the POST leg was fixed for.
        agent: loopbackAgent,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

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

/** One connected tab as `reticle status` reports it — the at-a-glance health line. */
interface StatusSession {
  sessionId: string;
  url: string;
  projectId?: string;
  throttled: boolean;
  /**
   * The tab is backgrounded. Reported by the daemon on every session; `false` on one too old to say,
   * which reads as visible — the conservative answer, since it keeps the reuse this command has
   * always done rather than opening a tab on a guess.
   */
  hidden: boolean;
  stale: boolean;
  pendingMarks: number;
  /** The tab is attached and answering nothing — see Session.unresponsive. Absent on an older daemon. */
  unresponsive?: true;
}

/**
 * Reduce the daemon's /status JSON to the compact view `reticle status` prints. Pure: narrows the
 * untrusted wire payload (never `any`) and tolerates a missing/partial body so a malformed response
 * degrades to "running, 0 sessions" instead of throwing.
 */
export function summarizeStatus(payload: unknown): {
  sessionCount: number;
  sessions: StatusSession[];
  why?: string;
  /** The same diagnosis without the differential, for a surface a person reads. */
  whyLead?: string;
} {
  if (typeof payload !== 'object' || null === payload) return { sessionCount: 0, sessions: [] };
  const obj = payload as Record<string, unknown>;
  // Carried through to the printed line: with no sessions this is the whole answer, and dropping it
  // here would silently undo the reason it is on the wire.
  const why = 'string' === typeof obj['why'] ? obj['why'] : undefined;
  // Absent on a daemon older than this field, which is why every reader falls back to `why`.
  const whyLead = 'string' === typeof obj['whyLead'] ? obj['whyLead'] : undefined;
  const raw = Array.isArray(obj['sessions']) ? obj['sessions'] : [];
  const sessions = raw
    .map((s): StatusSession | null => {
      if (typeof s !== 'object' || null === s) return null;
      const r = s as Record<string, unknown>;
      const sessionId = 'string' === typeof r['sessionId'] ? r['sessionId'] : '';
      if ('' === sessionId) return null;
      return {
        sessionId,
        url: 'string' === typeof r['url'] ? r['url'] : '',
        ...('string' === typeof r['projectId'] && 0 < r['projectId'].length
          ? { projectId: r['projectId'] }
          : {}),
        throttled: true === r['throttled'],
        hidden: true === r['hidden'],
        stale: true === r['stale'],
        pendingMarks: 'number' === typeof r['pendingMarks'] ? r['pendingMarks'] : 0,
        ...(true === r['unresponsive'] ? { unresponsive: true as const } : {}),
      };
    })
    .filter((s): s is StatusSession => s !== null);
  const sessionCount =
    'number' === typeof obj['sessionCount'] ? obj['sessionCount'] : sessions.length;
  return {
    sessionCount,
    sessions,
    ...(why === undefined ? {} : { why }),
    ...(whyLead === undefined ? {} : { whyLead }),
  };
}

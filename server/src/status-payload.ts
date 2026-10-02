/**
 * What `GET /status` answers — the daemon describing itself.
 *
 * Carries the daemon's OWN version, because a daemon outlives every agent attached to it: after an
 * upgrade the new CLI attaches to the old daemon and serves its code, and until this field existed
 * there was no surface anywhere — not /status, not `reticle status` — naming the version actually
 * answering requests. See takeVersionSkewOnto in command/version/version-nudge.ts.
 */
import type { SessionInfo } from './portal/session/session-info.js';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { SERVER_VERSION } from './command/version/identity/server-version.js';

interface StatusPayload {
  running: true;
  version: string;
  /** The wire contract this daemon speaks — what another process compares against, not the version. */
  contract: string;
  sessionCount: number;
  sessions: SessionInfo[];
  /**
   * Why nothing is connected — present ONLY when `sessionCount` is 0, so a diagnosis never prints
   * beside a live session.
   */
  why?: string;
  /**
   * The same diagnosis with the differential left off: the lead and the next action.
   *
   * Two fields because there are two readers. `why` is for an agent about to spend a drive on a
   * guess, and carries the ranked causes, the port-scan caveat and the lease offer. `whyLead` is
   * for a surface a PERSON reads: `reticle init` prints the daemon's account of a failed connect,
   * and was printing roughly five hundred words of it in one paragraph.
   */
  whyLead?: string;
  /** Port of the verify HTTP endpoint this daemon serves — present only when started with `--http`. */
  verifyPort?: number;
}

export function statusPayload(
  sessionCount: number,
  sessions: SessionInfo[],
  /** The no-session diagnosis, injected so this stays pure and the port probe stays off this path. */
  why?: string,
  verifyPort?: number,
  /** The short rendering of the same diagnosis. Absent on a daemon that has no provider wired. */
  whyLead?: string,
): StatusPayload {
  return {
    running: true,
    version: SERVER_VERSION,
    contract: CONTRACT_FINGERPRINT,
    sessionCount,
    sessions,
    // Only when there is nothing to explain away: a diagnosis printed beside a live session would
    // contradict it.
    ...(0 === sessionCount && why !== undefined ? { why } : {}),
    ...(0 === sessionCount && whyLead !== undefined ? { whyLead } : {}),
    ...(verifyPort === undefined ? {} : { verifyPort }),
  };
}

/**
 * Why `serve --http` cannot claim success against an already-running daemon — or undefined when
 * that daemon already serves the verify HTTP endpoint on the wanted port.
 *
 * `serve` never hands flags to a daemon that is already up, so `--http`/`--http-port` against one
 * used to be accepted, dropped, and reported as success (#687). This is the read side of the
 * `verifyPort` field above: the daemon says which port it serves, and `serve` compares. A daemon
 * too old to report the field — or one that did not answer /status — reads as "not honoured",
 * which errs loud rather than green.
 */
export function verifyEndpointMismatch(status: unknown, wantedPort: number): string | undefined {
  const served =
    'object' === typeof status && status !== null
      ? (status as Record<string, unknown>)['verifyPort']
      : undefined;
  if (served === wantedPort) return undefined;
  const fix = 'stop it (`reticle stop`) and run `reticle serve --http` again';
  return 'number' === typeof served
    ? `the daemon already running serves the verify HTTP endpoint on :${String(served)}, not :${String(wantedPort)} — ${fix}`
    : `a daemon is already running without the verify HTTP endpoint — \`--http\` cannot be applied to it; ${fix}`;
}

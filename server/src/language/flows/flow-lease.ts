/**
 * What a flow needs from the live session to run in a leased context, and what it reports when the
 * lease never came up.
 */

import { ReplayStatus, type FlowReplayResult } from '@reticlehq/core';
import { AppRuntime } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

/**
 * The URL a leased context should open: the app's ORIGIN, not the live tab's current location.
 *
 * The live tab drifts — every replay navigates it — so using its full URL made each lease start wherever
 * the previous run happened to finish (observed: leases opening /deployments and failing to find the
 * login control that only exists at the root). A lease must be a FRESH visit to a deterministic entry
 * point; flows that need another page carry their own startPath.
 */
export function leasableAppUrl(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    const session = deps.sessions.resolve(sessionId);
    if (AppRuntime.WEB !== (session.runtime ?? AppRuntime.WEB)) {
      return undefined;
    } // desktop: no IPC in a lease
    const url = session.url;
    if (typeof url !== 'string' || 0 === url.length) {
      return undefined;
    }
    return new URL(url).origin;
  } catch {
    return undefined; // no live session (or an unparseable URL) → sequential path
  }
}

/**
 * The live session's own URL — what the fixture port must be looked up by.
 *
 * NOT `leasableAppUrl`. That returns an ORIGIN, and the input provider finds a page by comparing
 * full URLs, so an origin matched no page: `suiteFixtureSeed` answered `undefined` on every run and
 * every leased flow booted cold while the code read as if it were seeded. Silent, because every
 * refusal on that path is deliberately silent — a fixture is an optimisation, and a suite must not
 * die when one is unavailable.
 */
export function sessionUrlOf(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    return deps.sessions.resolve(sessionId).url;
  } catch {
    return undefined;
  }
}

/** A flow whose leased context never came up is a suite ERROR, never a silent pass. */
export function leaseFailureReplay(name: string, error: string | undefined): FlowReplayResult {
  return {
    name,
    status: ReplayStatus.ERROR,
    steps: [],
    error: {
      code: ReplayStatus.ERROR,
      message: `could not run in a leased context: ${error ?? 'unknown error'}`,
    },
  };
}

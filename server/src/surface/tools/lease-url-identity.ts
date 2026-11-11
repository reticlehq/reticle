/**
 * Reticle's identity params on a lease URL: stamp them, read them back, carry them across a
 * navigation, and match a registered session to the lease that stamped it.
 *
 * Split out of lease-tools.ts at the 1000-line cap. Pure: no I/O.
 */

import { type HudVisibility, RETICLE_URL_PARAM } from '@reticlehq/core';

/**
 * Append Reticle identity params (__reticle_session, optional __reticle_project) to a URL so the app's own SDK
 * adopts them on connect. Pure; falls back to plain concatenation if the URL can't be parsed.
 */
export function appendReticleParams(
  url: string,
  session: string,
  projectId?: string,
  hud?: HudVisibility,
): string {
  try {
    const u = new URL(url);
    u.searchParams.set(RETICLE_URL_PARAM.SESSION, session);
    if (projectId !== undefined && projectId.length > 0) {
      u.searchParams.set(RETICLE_URL_PARAM.PROJECT, projectId);
    }
    if (hud !== undefined) {
      u.searchParams.set(RETICLE_URL_PARAM.HUD, hud);
    }
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    const proj =
      projectId !== undefined && projectId.length > 0
        ? `&${RETICLE_URL_PARAM.PROJECT}=${encodeURIComponent(projectId)}`
        : '';
    return `${url}${sep}${RETICLE_URL_PARAM.SESSION}=${encodeURIComponent(session)}${proj}`;
  }
}

/**
 * The session a lease's tab actually registered as, or undefined while nothing has.
 *
 * Normally that is the lease id: `appendReticleParams` stamps `__reticle_session` on the URL and the
 * SDK adopts it. An app that passes an explicit `session` to `connect()` keeps its own name instead,
 * which is legitimate — a single-app fixture does it deliberately so a battery can address it by a
 * known id. Matching on the lease id alone could never see those tabs, so the lease reported
 * `ready: false` and a hint blaming a port mismatch while the session was connected and driveable.
 *
 * The URL marker is the evidence, and it is what makes this safe: two concurrent leases on one origin
 * carry different markers, so neither can adopt the other's tab. Parsed rather than substring-matched,
 * so `lease-abc` cannot claim `lease-abcdef`.
 */
export function resolveLeasedSessionId(
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  leaseId: string,
): string | undefined {
  if (sessions.get(leaseId) !== undefined) {
    return leaseId;
  }
  return sessions.all().find((s) => sessionParamOf(s.url) === leaseId)?.id;
}

/**
 * Carry a claimed identity across a navigation.
 *
 * A LEASED tab is addressed by `__reticle_session` in its URL: that param is how the pool finds the
 * context it opened, and — since succession was tightened — it is also the ONLY thing that lets the
 * reconnecting document inherit the lease. `reticle_navigate` sent the caller's raw URL, so the very
 * first navigation stripped the marker, the tab re-announced as an ordinary anonymous session, and
 * the lease was orphaned: "no sessions are connected at all", with a browser window still open on
 * screen. A leased browser that cannot survive being navigated is not a usable one.
 *
 * A tab that claims nothing is left exactly as it was — this must never bolt Reticle's params onto
 * a human's own URL.
 */
export function carryReticleIdentity(fromUrl: string | undefined, toUrl: string): string {
  const session = sessionParamOf(fromUrl);
  if (session === undefined) {
    return toUrl;
  }
  // Already addressed (a caller passing the stamped URL back) — appending would be a no-op at best.
  if (sessionParamOf(toUrl) !== undefined) {
    return toUrl;
  }
  const projectId = projectParamOf(fromUrl);
  return appendReticleParams(toUrl, session, projectId);
}

function projectParamOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.PROJECT) ?? undefined;
  } catch {
    return undefined;
  }
}

function sessionParamOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.SESSION) ?? undefined;
  } catch {
    return undefined;
  }
}

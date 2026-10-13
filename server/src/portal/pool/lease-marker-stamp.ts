import { RETICLE_URL_PARAM } from '@reticlehq/core';
import type { PooledPage } from './pool-contract.js';

interface LeaseMarkerArg {
  session: string;
  project?: string | undefined;
  targetOrigin: string;
  sessionParam: string;
  projectParam: string;
}

interface W {
  top: unknown;
  location: URL;
  history: { replaceState(...a: unknown[]): void };
}

/**
 * Init script restoring the marker a server redirect dropped, so the SDK registers under the lease id.
 * It runs only in pages of the lease's own browser context, so a person's tab at the same URL never
 * carries the marker and is never adopted. It writes only in the top frame, only on the lease's own
 * target origin (never an identity provider's or any third party's URL), and the pool installs it
 * only when the navigated URL's marker matches this lease's id. Must stay self-contained: Playwright
 * serialises the function source into the page.
 */
export function stampLeaseMarker(arg: LeaseMarkerArg): void {
  const win = (globalThis as unknown as { window?: W }).window;
  if (win === undefined || win.top !== win || win.location.origin !== arg.targetOrigin) return;
  try {
    const url = new URL(win.location.href);
    if (url.searchParams.has(arg.sessionParam)) return;
    url.searchParams.set(arg.sessionParam, arg.session);
    if (arg.project !== undefined && !url.searchParams.has(arg.projectParam)) {
      url.searchParams.set(arg.projectParam, arg.project);
    }
    win.history.replaceState(null, '', url.toString());
  } catch {
    return;
  }
}

export async function installLeaseMarker(
  page: PooledPage,
  leaseId: string,
  targetOrigin: string | undefined,
  project: string | undefined,
): Promise<void> {
  if (page.addInitScript === undefined || targetOrigin === undefined) return;
  await page.addInitScript(stampLeaseMarker, {
    session: leaseId,
    project,
    targetOrigin,
    sessionParam: RETICLE_URL_PARAM.SESSION,
    projectParam: RETICLE_URL_PARAM.PROJECT,
  });
}

export function leaseMarkerOf(
  url: string,
): { session: string; project: string | undefined } | undefined {
  try {
    const params = new URL(url).searchParams;
    const session = params.get(RETICLE_URL_PARAM.SESSION) ?? '';
    const project = params.get(RETICLE_URL_PARAM.PROJECT) ?? '';
    return '' === session ? undefined : { session, project: '' === project ? undefined : project };
  } catch {
    return undefined;
  }
}

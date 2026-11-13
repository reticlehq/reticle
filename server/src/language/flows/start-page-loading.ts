/**
 * How replay asks whether the start page is still loading, past the step budget (#1705, #2155).
 *
 * A pool lease answers for its own page. Any other tab is the one `reticle verify` drives, and the
 * provider that opened it answers. Without that second probe, a dev server that compiled the start
 * page for longer than the budget made replay stop at 5 s on exactly the tab `verify` uses.
 */

/** The slice of the browser pool that knows its leases. */
interface LeaseLoading {
  leaseUrl(sessionId: string): string | undefined;
  leaseLoading(sessionId: string): Promise<boolean>;
}

/** The slice of the real-input provider that knows the one tab it drives. */
interface DrivenLoading {
  isAvailableFor(sessionUrl: string): Promise<boolean>;
  drivenPageLoading?(): Promise<boolean>;
}

/** The probe for this session's page, or undefined when nothing can see that page. */
export async function startPageLoadingProbe(
  pool: LeaseLoading | undefined,
  realInput: DrivenLoading | undefined,
  session: { id: string; url?: string },
): Promise<(() => Promise<boolean>) | undefined> {
  if (pool !== undefined && pool.leaseUrl(session.id) !== undefined) {
    return () => pool.leaseLoading(session.id);
  }
  const url = session.url;
  if (realInput?.drivenPageLoading === undefined || url === undefined) {
    return undefined;
  }
  // Asked before the navigation: after it, the tab has a new URL and the session has not caught up.
  const drivesThisTab = await realInput.isAvailableFor(url).catch(() => false);
  if (!drivesThisTab) {
    return undefined;
  }
  return () => realInput.drivenPageLoading?.() ?? Promise.resolve(false);
}

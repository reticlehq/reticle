/**
 * Browser permissions on a leased context: granted before the first navigation, and read back where
 * the browser can contradict the grant.
 *
 * Never changed on a lease that is already open. Acquire hands an origin's live lease to whoever asks
 * for that origin, so the lease may be another agent's tab mid-flow, and nothing here knows whose it
 * is. A different set means a fresh lease.
 *
 * Each grant is scoped to the origin the lease was opened on, so a third-party frame the app embeds
 * is not handed the same grant as the app.
 *
 * Notifications are why the read-back exists. Playwright's headless shell — what the pool launches
 * when Playwright's own Chromium is installed — has no notification support: after a grant,
 * `navigator.permissions.query` reports `granted` while `Notification.permission` still reads
 * `denied`. A page that gates its UI on the second never sees the grant, so a lease that reported
 * "granted" there would be reporting something the page cannot see.
 */
import { isLoopbackHostname } from '@reticlehq/core';
import { allowDaemonInCsp, allowDaemonInHtml } from './csp-widen.js';
import type { PooledContext, PooledPage } from './pool-contract.js';

/** The permission whose grant the headless shell does not pass on to `Notification.permission`. */
export const NOTIFICATIONS_PERMISSION = 'notifications';

/** Evaluated in the leased page. A string, because the pool's page surface evaluates scripts. */
export const NOTIFICATION_PERMISSION_READ =
  "typeof Notification === 'undefined' ? 'unsupported' : Notification.permission";

/**
 * How long a read-back may take. Bounded because acquire waits on it, and a wedged renderer never
 * answers an evaluation: an unbounded one would turn "this tab is stuck" into "acquire hangs".
 */
export const NOTIFICATION_READ_TIMEOUT_MS = 1_500;

/** Playwright prefixes its errors with the call that failed; the agent needs only the reason. */
const PLAYWRIGHT_CALL_PREFIX = /^browserContext\.\w+:\s*/;

/** A permission could not be granted or cleared. Its message is written for the agent. */
export class LeasePermissionError extends Error {
  override readonly name = 'LeasePermissionError';
}

function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n')[0] ?? message).replace(PLAYWRIGHT_CALL_PREFIX, '');
}

/** Grant `permissions` on the origin of `url`. Nothing to grant is a no-op, not a refusal. */
export async function grantLeasePermissions(
  context: PooledContext,
  permissions: readonly string[],
  url: string,
): Promise<void> {
  if (0 === permissions.length) {
    return;
  }
  if (context.grantPermissions === undefined) {
    throw new LeasePermissionError('this browser context cannot grant permissions');
  }
  try {
    await context.grantPermissions([...permissions], { origin: new URL(url).origin });
  } catch (err) {
    throw new LeasePermissionError(`could not grant ${permissions.join(', ')}: ${reasonOf(err)}`);
  }
}

/** The origin of `url` when the page is not on loopback, else undefined (also for no url). */
export function offLoopbackOrigin(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) {
    return undefined;
  }
  const target = new URL(url);
  return isLoopbackHostname(target.hostname) ? undefined : target.origin;
}

/** Playwright's name for Chrome's Local Network Access grant (local + loopback network). */
export const LOCAL_NETWORK_ACCESS = 'local-network-access';

/**
 * Let a page that is not on loopback dial the bridge on loopback. Chromium blocks that unless a
 * person grants Local Network Access, and a leased browser has no person, so a lease on a hosted
 * preview loaded, signed in, and answered `sdk_never_dialled`. A loopback page needs no grant.
 *
 * ponytail: best effort. A Playwright older than the permission name refuses it; the lease then
 * opens as before, and a page that cannot dial still reports `sdk_never_dialled`.
 */
export async function grantLocalNetworkAccess(context: PooledContext, url: string): Promise<void> {
  const origin = offLoopbackOrigin(url);
  if (context.grantPermissions === undefined || origin === undefined) {
    return;
  }
  try {
    await context.grantPermissions([LOCAL_NETWORK_ACCESS], { origin });
  } catch {
    // An unknown permission name on an older Playwright: open the lease without it.
  }
}

/**
 * What the page's `Notification.permission` says, or undefined when it cannot be asked.
 *
 * Read back rather than inferred from the grant, because the headless shell answers `denied`
 * after a notifications grant. Bounded, so a page that never answers reads as "could not ask"
 * instead of holding the caller.
 */
export async function readNotificationPermission(page: PooledPage): Promise<string | undefined> {
  if (page.evaluate === undefined) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), NOTIFICATION_READ_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([page.evaluate(NOTIFICATION_PERMISSION_READ), gaveUp]);
    return 'string' === typeof value ? value : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** How long the loopback CSP probe may take. Bounded because acquire waits on it. */
export const CSP_PROBE_TIMEOUT_MS = 2_000;

/** The part of `fetch` the probe uses. */
export type CspProbeFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Pick<Response, 'headers' | 'text'>>;

/**
 * Whether the document at `url` sends a CSP (header or meta tag) that would block a dial to
 * `daemonOrigin` (#2163). False when it cannot be asked: the lease then opens as before.
 */
export async function pageCspBlocksDaemon(
  url: string,
  daemonOrigin: string,
  probe: CspProbeFetch = fetch,
): Promise<boolean> {
  try {
    const response = await probe(url, { signal: AbortSignal.timeout(CSP_PROBE_TIMEOUT_MS) });
    const header = response.headers.get('content-security-policy');
    if (header !== null && allowDaemonInCsp(header, daemonOrigin).changed) {
      return true;
    }
    if (!/html/i.test(response.headers.get('content-type') ?? '')) {
      return false;
    }
    return allowDaemonInHtml(await response.text(), daemonOrigin).changed;
  } catch {
    return false;
  }
}

/**
 * On a lease whose page's CSP would block the daemon, add `daemonOrigin` to its `connect-src`
 * (#2016). Off loopback this always installs the route. On loopback it installs it only when a
 * probe of the page finds a CSP that blocks the dial (#2163), because the route sees every request
 * in the context, and a dev server that sends no CSP should not pay for it. The returned record
 * gets `widenedFor` once a response was really widened, so the lease can say so.
 */
export async function widenLeaseCsp(
  context: PooledContext,
  url: string,
  daemonOrigin: string | undefined,
  probe?: CspProbeFetch,
): Promise<{ widenedFor?: string }> {
  const widening: { widenedFor?: string } = {};
  if (daemonOrigin === undefined || context.widenCsp === undefined) {
    return widening;
  }
  const needed =
    offLoopbackOrigin(url) !== undefined ||
    (URL.canParse(url) && (await pageCspBlocksDaemon(url, daemonOrigin, probe)));
  if (needed) {
    await context.widenCsp(daemonOrigin, () => {
      widening.widenedFor = daemonOrigin;
    });
  }
  return widening;
}

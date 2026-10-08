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
import type { PooledContext } from './pool-contract.js';

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
  if (0 === permissions.length) return;
  if (context.grantPermissions === undefined) {
    throw new LeasePermissionError('this browser context cannot grant permissions');
  }
  try {
    await context.grantPermissions([...permissions], { origin: new URL(url).origin });
  } catch (err) {
    throw new LeasePermissionError(`could not grant ${permissions.join(', ')}: ${reasonOf(err)}`);
  }
}

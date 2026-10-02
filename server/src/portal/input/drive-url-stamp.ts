import { RETICLE_URL_PARAM } from '@reticlehq/core';

/**
 * The value the stamp carries for a launched drive.
 *
 * The lease pool stamps a real lease id; a drive owns exactly one page and has no id to give, so
 * the constant says what it is. Only its PRESENCE is read page-side.
 */
const OPENED_STAMP = '1';

/**
 * A drive's URL, marked so the page can tell Reticle opened it.
 *
 * Every page Reticle opens for itself should be able to say so, and only the lease pool could: the
 * launched provider navigated to the bare URL, so its page was indistinguishable from a developer's
 * own tab. That mattered the moment the first-run tour shipped — the page got the tour, and the
 * tour's scrim takes `pointer-events: auto` deliberately, so it swallowed every native click and
 * hover the drive made. The drive reported `dispatched: true` the whole time, because from the
 * server's side the mouse HAD moved; it landed on the scrim.
 *
 * An unparseable URL is returned untouched. A navigation that happens without the stamp is a page
 * showing a tour it should not; a navigation that does not happen at all is the feature gone.
 */
export function stampedDriveUrl(driveUrl: string): string {
  try {
    const url = new URL(driveUrl);
    // OPENED, never SESSION: the session param doubles as the session ID when the app names none,
    // so stamping it here would rename every driven session to one constant and collide two drives.
    url.searchParams.set(RETICLE_URL_PARAM.OPENED, OPENED_STAMP);
    return url.toString();
  } catch {
    return driveUrl;
  }
}

/**
 * Whether the self-serve escape hatch can actually be taken, said in the same breath as the offer.
 *
 * `reticle_lease` is what `status`, `doctor` and the no-session diagnosis all recommend when no tab
 * is connected: it opens a browser Reticle drives itself, so the agent does not have to wait for a
 * human. It is the right advice and it is the one thing that cannot work when Chromium is missing or
 * sitting at a revision this Playwright will not use — and the command giving the advice is usually
 * the command that just diagnosed exactly that.
 *
 * Reported from the field, verbatim in shape: `doctor` printed `chromium ✗ wrong revision — the
 * bundled playwright wants chromium-1234; the cache holds chromium-1228`, and then offered the lease
 * as the way out. The reporter followed it, and could not have succeeded.
 *
 * Two things this refuses to do:
 *
 * **It does not fire on an absent probe.** A probe that could not run is not evidence the browser is
 * missing, and a caveat asserting otherwise would be the same overclaiming this file exists to stop.
 *
 * **It does not tell the agent to install the browser.** A ~150MB download on somebody else's
 * machine is not an agent's call to make unprompted, so the message names the command and hands it
 * to the human rather than implying the agent should just run it.
 */

/** What the caller learned about the browser. Gathered by the caller so this stays pure. */
export interface LeaseBrowserState {
  /** Does the executable this Playwright wants actually exist on disk? */
  exists: boolean;
  /** The install command, already pinned to the bundled Playwright by `chromium-hint`. */
  installCommand?: string | undefined;
  /** The revision this Playwright wants, when the path names one. */
  wantedRevision?: string | undefined;
  /** Chromium revisions actually present, wanted or not. */
  installedRevisions?: readonly string[] | undefined;
}

/**
 * The sentence to append to a lease recommendation, or undefined when the lease is fine.
 *
 * Undefined rather than an empty string on the healthy path: a caller composing a message should not
 * have to filter blanks, and a healthy install must pay nothing at all for this check.
 */
export function leaseCaveat(state: LeaseBrowserState | undefined): string | undefined {
  if (state === undefined || state.exists) return undefined;

  // Present-at-the-wrong-revision and absent-entirely have different fixes and different readings,
  // and collapsing them is what made the reported loop unbreakable — "the check is broken" and
  // "none of these count" look identical from a flat `missing`.
  const installed = state.installedRevisions ?? [];
  const mismatch =
    state.wantedRevision !== undefined && installed.length > 0
      ? ` This Playwright wants ${state.wantedRevision} and the cache holds ${installed.join(', ')}, so the builds already on this machine will not be used.`
      : '';

  const command = state.installCommand === undefined ? '' : ` The fix is: ${state.installCommand}.`;

  return (
    'NOTE — reticle_lease cannot run here: it drives a Reticle-owned Chromium and that browser is ' +
    `not available.${mismatch}${command} That download is the human's call, not something to run ` +
    'unprompted on their machine, so hand this back rather than treating the lease as a way forward.'
  );
}

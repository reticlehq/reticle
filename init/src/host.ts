import type { InitOutcome, OnboardingStep } from '@reticlehq/core/telemetry';
import { RETICLE_VERSION } from './version.js';

/**
 * Everything the scaffolder needs that only the daemon knows.
 *
 * `@reticlehq/init` writes files and runs a package manager; it never opens a socket, reads the
 * bridge's state directory or emits an event. Those four capabilities used to arrive as imports
 * from `@reticlehq/server`, which is exactly what made the scaffolder impossible to release on its
 * own. They arrive as this object instead, carried on `InitIo` so every internal stage that already
 * threads the IO gets it for free rather than growing a second parameter.
 *
 * Every member is REQUIRED. `reportOutcome` in particular: telemetry fails silently, and an optional
 * reporter is a reporter somebody forgets to pass and nobody ever notices is missing. A caller with
 * genuinely nothing to report says so out loud with `SILENT_HOST`.
 */
export interface InitHost {
  /**
   * Wrap one internal stage so it can be traced. Must call `fn` exactly once and return its value.
   * The daemon passes `spanSync`; everything else passes the identity below.
   */
  span<T>(name: string, fields: Record<string, unknown>, fn: () => T): T;
  /** Report how the run went. Best-effort — setup must never fail because a metric did. */
  reportOutcome(outcome: InitOutcome): void;
  /**
   * Report ONE step of the setup funnel, as it happens.
   *
   * `reportOutcome` fires once, at the end, and says whether the whole run succeeded. That cannot
   * answer the question the funnel exists for — WHERE people stop — because a run that dies at the
   * MCP registration and one that dies before it ever looked for a package.json are the same single
   * row. A step reported as it happens is the difference between "init failed" and "init failed at
   * this step, on this stack, after this long".
   *
   * REQUIRED for the same reason `reportOutcome` is: an optional reporter is one somebody forgets to
   * pass and nobody notices is missing, because telemetry fails silently.
   */
  reportStep(step: OnboardingStep): void;
  /**
   * The daemon's pairing token, minted if nothing has written one yet.
   *
   * `init` inlines this into the CDN snippet, which has no build step — so an empty value there is a
   * page that can never authenticate, and a token regenerated later makes the pasted literal stale.
   * Minting belongs to the bridge, which owns the file; the scaffolder only asks for it.
   */
  pairingToken(): string;
  /** The install channel the environment declares, or undefined when nothing declared one. */
  installSource(): string | undefined;
  /**
   * The Reticle release DRIVING this run — the daemon's own version, not the scaffolder's.
   *
   * `init` pins the SDK install to an exact version so a stale registry cache cannot hand the app a
   * different release from the one the daemon speaks. Which version that is, it cannot know for
   * itself: it can only read `@reticlehq/init`'s manifest, and that answers "which scaffolder is
   * this" rather than "which Reticle is running". The two are the same package graph in this
   * repository and are NOT the same fact on a user's machine, where npm assembles the tree.
   *
   * Reported from the field (#990): a daemon reporting 3.1.0 installed `@reticlehq/react@2.14.0`
   * and `@reticlehq/next@2.14.0` on a clean install — every step green, nothing naming the
   * disagreement, and the agent then handed the version-skew remediation for a skew `init` had just
   * created. Asking the host closes the gap at the seam it opens at: the daemon knows its own
   * version, and it is the only participant that does.
   *
   * REQUIRED, like the two reporters above it. An optional version is one somebody forgets to pass,
   * and the failure is a silently skewed install that reports success.
   */
  releaseVersion(): string;
}

/**
 * A host that does nothing, for callers that drive `init`'s file surface without running an install
 * — `reticle update`'s agent-rules refresh, and the in-memory IO the unit tests build.
 *
 * Named rather than spelled inline at each call site so "this run reports nothing" is a decision
 * somebody made once and can grep for, instead of four independently-forgotten reporters.
 */
export const SILENT_HOST: InitHost = {
  span<T>(_name: string, _fields: Record<string, unknown>, fn: () => T): T {
    return fn();
  },
  reportOutcome() {
    /* nothing to report to */
  },
  reportStep() {
    /* nothing to report to */
  },
  pairingToken() {
    return '';
  },
  installSource() {
    return undefined;
  },
  /**
   * The scaffolder's own release, which is the only version a host with no daemon behind it can
   * truthfully name — and still a real pin, so a host-less caller cannot fall through to an
   * unpinned install.
   */
  releaseVersion() {
    return RETICLE_VERSION;
  },
};

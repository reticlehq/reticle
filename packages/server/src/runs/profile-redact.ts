/**
 * Profile gating for the verification-run artifact. A DEV run keeps everything (it stays on the
 * developer's machine). A PROD_PREVIEW run is one a host may surface downstream (attach to a deploy,
 * show an end customer), so it must not leak the app's internals: the repair packets (which name
 * source files + carry fix instructions) are dropped, and app-state assertion values are redacted.
 * The trustworthy summary — verdict, flows, risks, counts — is preserved. Pure; keyed on run.profile.
 */

import { RunProfile, type ReticleVerificationRun } from '@reticle/protocol';

/** Marker left in place of a redacted value so a consumer can tell it was withheld, not absent. */
export const REDACTED = '[redacted:prod-preview]';

/**
 * Return the run unchanged for DEV; for PROD_PREVIEW return a copy with dev-only fields removed:
 * the repair block (source-naming) is dropped and stateAssertion values are redacted.
 */
export function redactForProfile(run: ReticleVerificationRun): ReticleVerificationRun {
  if (run.profile !== RunProfile.PROD_PREVIEW) return run;

  const evidence = {
    ...run.evidence,
    stateAssertions: run.evidence.stateAssertions.map((s) => ({
      store: s.store,
      path: s.path,
      expected: REDACTED,
      actual: REDACTED,
      ok: s.ok,
    })),
  };

  const { repair, ...rest } = run;
  void repair; // intentionally dropped — fix instructions name source files
  return { ...rest, evidence };
}

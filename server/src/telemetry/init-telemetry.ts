/**
 * How `reticle init` went.
 *
 * The onboarding funnel had no instrumentation at all, which meant the two most different failure
 * modes were indistinguishable: someone whose setup died on a missing dependency looked exactly like
 * someone who installed the package and never ran the command. One is a bug we can fix; the other is
 * a marketing problem. Both showed up as silence.
 *
 * `reticle init` runs as a one-shot CLI command that exits immediately, so the send is DETACHED — the
 * same treatment `cli_command_run` gets, for the same reason: an in-process fetch would keep the
 * event loop alive and tax the command by most of a second.
 */
import { TelemetryEventKind, type InitOutcome } from '@reticlehq/core/telemetry';
import { getTelemetry } from './telemetry.js';
import { resolveInstallSource } from './install-source.js';

// The failure vocabulary lives in `@reticlehq/init`, which is what classifies a failed run.
// Re-exported so every consumer here is unchanged.
export { InitFailure } from '@reticlehq/init';

/** Report one init outcome. Best-effort; setup must never fail because a metric did. */
export function reportInitOutcome(init: InitOutcome): void {
  try {
    void getTelemetry().emit(TelemetryEventKind.INIT_COMPLETED, {
      init,
      detach: true,
      // The other half of attribution: `reticle_installed` says a machine arrived, this says the
      // setup on it finished, and only together do they say which route converts. Same self-declared
      // marker, same refusal to infer — see install-source.ts.
      installSource: resolveInstallSource(),
    });
  } catch {
    /* a metric must never break `reticle init` */
  }
}

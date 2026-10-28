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
import {
  OnboardingPhase,
  OnboardingStop,
  TelemetryEventKind,
  type InitOutcome,
} from '@reticlehq/core/telemetry';
import { InitFailure } from '@reticlehq/init';
import { getTelemetry } from './telemetry.js';
import { INSTALL_STATE_DIR, resolveInstallSource } from './install-source.js';
import { reportOnboardingStop } from './onboarding-funnel.js';

// The failure vocabulary lives in `@reticlehq/init`, which is what classifies a failed run.
// Re-exported so every consumer here is unchanged.
export { InitFailure };

const PROJECT_DETECTED = 'project_detected';
const INSTRUMENTED = 'instrumented';
const APP_CONNECTED = 'app_connected';

/**
 * Each init failure as one stop, with the first-run step it blocked. A `Record` over the whole
 * enum, so a new `InitFailure` does not compile until it names its stop.
 */
const INIT_STOP: Readonly<Record<InitFailure, { step: string; stop: OnboardingStop }>> = {
  [InitFailure.NO_PACKAGE_JSON]: { step: PROJECT_DETECTED, stop: OnboardingStop.NO_WEB_APP },
  [InitFailure.MALFORMED_PACKAGE_JSON]: {
    step: PROJECT_DETECTED,
    stop: OnboardingStop.SETUP_FAILED,
  },
  [InitFailure.PREFLIGHT]: { step: PROJECT_DETECTED, stop: OnboardingStop.SETUP_FAILED },
  [InitFailure.DEPENDENCY_INSTALL]: { step: INSTRUMENTED, stop: OnboardingStop.SETUP_FAILED },
  [InitFailure.MCP_REGISTRATION]: { step: INSTRUMENTED, stop: OnboardingStop.MCP_NOT_REGISTERED },
  [InitFailure.OTHER]: { step: INSTRUMENTED, stop: OnboardingStop.UNCLASSIFIED },
  [InitFailure.BRIDGE_OCCUPIED]: { step: APP_CONNECTED, stop: OnboardingStop.SETUP_FAILED },
  [InitFailure.DEV_SERVER]: { step: APP_CONNECTED, stop: OnboardingStop.DEV_SERVER_FAILED },
  [InitFailure.APP_CONNECTION]: { step: APP_CONNECTED, stop: OnboardingStop.APP_NOT_CONNECTED },
  [InitFailure.RUNTIME_ERROR]: { step: APP_CONNECTED, stop: OnboardingStop.UNCLASSIFIED },
  [InitFailure.INTERRUPTED]: { step: APP_CONNECTED, stop: OnboardingStop.INTERRUPTED },
};
const INIT_STOP_UNKNOWN = INIT_STOP[InitFailure.OTHER];

function initStop(reason: string | undefined): { step: string; stop: OnboardingStop } {
  if (reason !== undefined && Object.hasOwn(INIT_STOP, reason)) {
    return INIT_STOP[reason as InitFailure];
  }
  return INIT_STOP_UNKNOWN;
}

/** The stop row of a failed init, or nothing for a run that worked. */
function reportInitStop(init: InitOutcome): void {
  if (init.ok) {
    return;
  }
  reportOnboardingStop(
    {
      phase: OnboardingPhase.FIRST_RUN,
      ...initStop(init.reason),
      ...(init.reason === undefined ? {} : { reason: init.reason }),
      ...(init.stack === undefined ? {} : { stack: init.stack }),
    },
    { detach: true },
  );
}

/** Report one init outcome. Best-effort; setup must never fail because a metric did. */
export function reportInitOutcome(init: InitOutcome): void {
  try {
    void getTelemetry().emit(TelemetryEventKind.INIT_COMPLETED, {
      init,
      detach: true,
      // The other half of attribution: `reticle_installed` says a machine arrived, this says the
      // setup on it finished, and only together do they say which route converts. Same self-declared
      // marker, same refusal to infer — see install-source.ts.
      installSource: resolveInstallSource(process.env, INSTALL_STATE_DIR),
    });
    reportInitStop(init);
  } catch {
    /* a metric must never break `reticle init` */
  }
}

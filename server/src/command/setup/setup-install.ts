import {
  OnboardingPhase,
  OnboardingStepStatus,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';

/**
 * What the one-line installer did, reported by the half that can report.
 *
 * `install/install.sh` (and its PowerShell twin) measures three durations it alone can see — they span the time before this
 * binary existed — and hands them over. Everything after that is decided here, because a `.sh` and
 * a `.ps1` carrying the same logic drift the first time somebody fixes a bug in one of them. The
 * shell's whole job is: is there a runtime, put the CLI on the machine, exec this.
 *
 * Pure over its inputs so the reporting is testable without installing anything.
 */
export interface InstallReport {
  readonly runtimeSecs: number;
  readonly installSecs: number;
}

export function reportInstallSteps(
  report: InstallReport,
  /** Injected for the same reason as in setup-mcp: this directory does not own a telemetry client. */
  reportStep: (step: OnboardingStep) => void,
): void {
  /*
   * `script_started` carries no duration, and that is not an oversight.
   *
   * The script's own start has nothing to measure against — it IS the origin. An `elapsedMs: 0`
   * would enter every average as a real zero and drag it toward a number nobody experienced;
   * absent means NOT MEASURED, which is what this is.
   */
  reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'script_started',
    status: OnboardingStepStatus.COMPLETED,
  });
  reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'runtime_ready',
    status: OnboardingStepStatus.COMPLETED,
    ...secs(report.runtimeSecs),
  });
  // Reaching here AT ALL means the CLI is installed and on PATH: the shell execs this binary by
  // name, so anything that would have made `cli_installed` false already exited before we ran.
  reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'cli_installed',
    status: OnboardingStepStatus.COMPLETED,
    ...secs(report.installSecs),
  });
}

/**
 * Seconds to milliseconds, or nothing.
 *
 * Zero is dropped rather than sent: the shell passes 0 when a step was too fast to measure at
 * whole-second resolution, and a real 0ms install did not happen. Same rule as `script_started`.
 */
function secs(value: number): { elapsedMs: number } | Record<string, never> {
  return value > 0 ? { elapsedMs: value * 1000 } : {};
}

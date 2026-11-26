/**
 * The runtime of a session as telemetry sends it. A session says its own runtime, and a realm that
 * a host registered has a name of its own choice: that name never leaves the machine.
 */
import { TelemetryRuntime } from '@reticlehq/core';

const KNOWN: ReadonlySet<string> = new Set(Object.values(TelemetryRuntime));

/** The runtime from our closed list, `other` for any other name, and nothing when none was said. */
export function telemetryRuntimeOf(runtime: string | undefined): TelemetryRuntime | undefined {
  if (runtime === undefined) {
    return undefined;
  }
  return KNOWN.has(runtime) ? (runtime as TelemetryRuntime) : TelemetryRuntime.OTHER;
}

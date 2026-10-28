/**
 * One line at the end of `reticle gate`, `reticle verify` and `reticle affected` when they run in a
 * CI runner or a container. It names the pull request check and the page that tells more about it.
 *
 * Rules: one line; never in an interactive terminal; never in a machine output mode; off with
 * `RETICLE_NO_CI_HINT`. It goes to stderr. The stdout of `verify` carries the verdict lines that a
 * pipeline reads, and stderr already carries the human notes of these commands.
 *
 * No network call. The latest version comes from the update manifest that the update check already
 * caches on disk. When there is no cache, the line does not compare versions.
 *
 * The caller gives the automation hint (`currentAutomationHint`): `telemetry` already reaches this
 * directory, so this directory does not reach back.
 */
import { AutomationHint } from '@reticlehq/core/telemetry';
import { parseMajor } from '@reticlehq/init';
import { loadManifest } from '@/command/update/update-checker.js';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';

/** Set to `1` to stop the line. */
export const CI_HINT_SILENCE_ENV = 'RETICLE_NO_CI_HINT';

/** The page that tells about the pull request check. */
export const CI_HINT_URL = 'https://reticle.sh/ci';

/** The env values that do not turn the line off. */
const NOT_SILENCED = new Set(['', '0', 'false']);

/** The automation hints that get the line. A hosted workspace or an agent sandbox is a person. */
const CI_HINT_AUTOMATION: ReadonlySet<AutomationHint> = new Set([
  AutomationHint.CI_RUNNER,
  AutomationHint.CONTAINER,
]);

const CiHintCopy = {
  CHECK: `Reticle: a pull request check shows each replay, the run history and a merge block. Read ${CI_HINT_URL}`,
  BEHIND: (current: string, latest: string) =>
    `Reticle: this engine (${current}) is a major version behind ${latest}. Update it, then read ${CI_HINT_URL}`,
} as const;

export interface CiHintInput {
  env: NodeJS.ProcessEnv;
  automation: AutomationHint | undefined;
  /** A person watches the output in a terminal. */
  interactive: boolean;
  /** The command writes output for a program to read (JSON, an agent hook). */
  machineOutput: boolean;
  currentVersion: string;
  /** The latest version from the cached update check, if there is one. */
  latestVersion: string | undefined;
}

/** The line, or undefined when it must not print. Pure. */
export function ciHintLine(input: CiHintInput): string | undefined {
  if (!NOT_SILENCED.has(input.env[CI_HINT_SILENCE_ENV] ?? '')) {
    return undefined;
  }
  if (input.interactive || input.machineOutput) {
    return undefined;
  }
  if (input.automation === undefined || !CI_HINT_AUTOMATION.has(input.automation)) {
    return undefined;
  }
  const current = parseMajor(input.currentVersion);
  const latest = parseMajor(input.latestVersion);
  if (current !== undefined && latest !== undefined && latest > current) {
    return CiHintCopy.BEHIND(input.currentVersion, input.latestVersion ?? '');
  }
  return CiHintCopy.CHECK;
}

export interface CiHintPorts {
  env: NodeJS.ProcessEnv;
  interactive: () => boolean;
  latestVersion: () => string | undefined;
  write: (text: string) => void;
}

const realPorts = (): CiHintPorts => ({
  env: process.env,
  interactive: () => true === process.stdout.isTTY || true === process.stderr.isTTY,
  latestVersion: () => loadManifest()?.latestVersion,
  write: (text) => process.stderr.write(text),
});

/** Write the line to stderr when it applies. Call it last, after the command's own output. */
export function writeCiHint(args: {
  automation: AutomationHint | undefined;
  machineOutput: boolean;
  ports?: CiHintPorts;
}): void {
  const ports = args.ports ?? realPorts();
  const line = ciHintLine({
    env: ports.env,
    automation: args.automation,
    interactive: ports.interactive(),
    machineOutput: args.machineOutput,
    currentVersion: SERVER_VERSION,
    latestVersion: ports.latestVersion(),
  });
  if (line !== undefined) {
    ports.write(`${line}\n`);
  }
}

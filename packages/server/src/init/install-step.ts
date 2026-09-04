/**
 * The dependency-install step: what is already there, whether that is enough, and what to do.
 *
 * Split out of `plan.ts` and `run.ts`, both at the 1000-line backstop, and split as a cohesive unit
 * rather than an arbitrary cut: all three parts are one step. `readInstalledPackages` looks,
 * `resolvedInstall` decides, `installStep` reports.
 *
 * It is one unit because of #683: the step's idempotent re-check used to be the install command
 * itself, so a project whose packages were already there had `init` execute the same failing command
 * again and report a correct install as broken. Verifying instead of re-running is only possible
 * when the looking and the deciding sit next to the reporting.
 */
import { join } from 'node:path';

import { frameworkPackages, pinnedPackages, StepStatus, unpinnedRetryNote } from './plan.js';
import { installCommand, installCommandParts } from './detect.js';
import { installFailureHint } from './install-hint.js';

import type { Framework, UiLibrary } from './detect.js';
import type { PlanInput, Step } from './plan.js';

/** The slice of `InitIo` this needs. Structural, so `run.ts` can hand over its own io. */
interface ReadOnlyIo {
  readFile(relPath: string): string | null;
}

/**
 * The version each required package RESOLVES to from this app directory.
 *
 * Read from `node_modules/<name>/package.json` rather than from the app's own dependency list,
 * because the question the install step asks is whether the package is THERE. A dependency
 * declared but never installed, and a package installed by hand and not declared, are both real
 * and they answer that question differently.
 *
 * An unreadable or unparseable manifest reads as absent, so the step installs. A missing reading
 * must never be able to SKIP an install.
 */
export function readInstalledPackages(
  io: ReadOnlyIo,
  detection: { framework: Framework; uiLibrary: UiLibrary },
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = {};
  for (const name of frameworkPackages(detection.framework, detection.uiLibrary)) {
    const raw = io.readFile(join('node_modules', ...name.split('/'), 'package.json'));
    if (null === raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const version =
        'object' === typeof parsed && null !== parsed
          ? (parsed as { version?: unknown }).version
          : undefined;
      if ('string' === typeof version && version.length > 0) resolved[name] = version;
    } catch {
      // Unparseable is absent: install rather than guess.
    }
  }
  return resolved;
}
/**
 * Are every one of these packages already resolvable, at the version asked for?
 *
 * Returns the line to report when they are, and `undefined` when anything is missing or skewed --
 * so the caller reads it as "already" or falls through to installing, with no third state to
 * mishandle.
 *
 * A resolved version that differs from a PINNED one is NOT satisfied. That is the version-skew case
 * this repo pins packages for at all: an older SDK against a newer daemon surfaces as a -32000 with
 * nothing naming a version, and reporting it as "already installed" would be the report agreeing
 * with the broken state.
 *
 * Undefined facts mean "not read", so the step installs. A missing reading must not be able to
 * SKIP an install -- the direction an absent fact should be wrong in.
 */
export function resolvedInstall(
  packages: readonly string[],
  installed: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (installed === undefined) return undefined;
  const resolved: string[] = [];
  for (const spec of packages) {
    // `@scope/name@version` — the version is after the LAST `@`, and a scoped name starts with one.
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const wanted = at > 0 ? spec.slice(at + 1) : undefined;
    const found = installed[name];
    if (found === undefined || 0 === found.length) return undefined;
    if (wanted !== undefined && wanted !== found) return undefined;
    resolved.push(`${name}@${found}`);
  }
  return `already installed: ${resolved.join(', ')}`;
}

export function installStep(input: PlanInput): Step {
  const pm = input.detection.packageManager;
  const packages = pinnedPackages(
    frameworkPackages(input.detection.framework, input.detection.uiLibrary),
    input.options.sdkVersion,
  );
  const command = installCommand(pm, packages);
  if (!input.options.install) {
    return {
      title: 'Install dependencies',
      target: 'package.json',
      status: StepStatus.MANUAL,
      detail: command,
    };
  }
  // Verify, do not re-run.
  //
  // The re-check used to be the install command itself, so a project whose packages were already
  // there -- installed by hand after a first run failed, or by a teammate -- had `init` execute the
  // same failing command again and report `⚠ Install dependencies — step failed` over a correct
  // install (#683). Resolving the packages answers the question the step is actually asking, and it
  // answers it in the state the app is in rather than by reproducing the state it got there from.
  const satisfied = resolvedInstall(packages, input.installedPackages);
  if (satisfied !== undefined) {
    return {
      title: 'Install dependencies',
      target: 'package.json',
      status: StepStatus.ALREADY,
      detail: satisfied,
    };
  }
  const parts = installCommandParts(pm, packages);
  return {
    title: 'Install dependencies',
    target: 'package.json',
    status: StepStatus.APPLY,
    detail: command,
    exec: {
      command: parts.command,
      args: parts.args,
      fallback: `${command}\n\n${installFailureHint(pm)}`,
    },
    // Unpinned. pnpm resolves the newest MATURE version there, which is how a project with a
    // release-age hold gets a working install instead of no install.
    retry: {
      ...installCommandParts(
        pm,
        frameworkPackages(input.detection.framework, input.detection.uiLibrary),
      ),
      note: unpinnedRetryNote(input.options.sdkVersion, pm),
    },
  };
}

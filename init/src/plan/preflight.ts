/**
 * The two conditions that make every later phase fail, checked before anything is written.
 *
 * Both lived in setup/reticle.mjs and neither survived the port into `init`. What they buy is the
 * distance between a failure and its cause: without them, an unwritable checkout arrives as EACCES
 * in a stack trace at phase four, and a missing package manager arrives as `spawn pnpm ENOENT`
 * inside "the dev server exited" — which sends the reader into their own dev script hunting a bug
 * that is not there.
 */

/** The parts of the environment preflight reads, so the rules are testable without a filesystem. */
export interface PreflightIo {
  /** Absolute path of the directory init is running in. */
  cwd(): string;
  /** Can this process write into the project root. */
  canWrite(): boolean;
  /** Runs a command quietly for a yes/no check; true on exit code 0. */
  probe(command: string, args: readonly string[]): boolean;
}

/**
 * npm ships with node, so refusing for its absence would refuse on a machine that is fine.
 */
const ALWAYS_PRESENT = 'npm';

/** The one program allowed to run a package manager it cannot find on PATH itself. */
const COREPACK = 'corepack';

/**
 * The prefix this run can actually invoke `packageManager` through, or undefined when neither the
 * bare binary nor corepack can.
 *
 * Reported from the field (#1149): a Windows machine with a corepack-managed pnpm — no `pnpm` on
 * PATH, only `corepack`, which resolves it from the project's `packageManager` field — failed the
 * bare `pnpm --version` probe and refused, even though `corepack pnpm --version` succeeds and every
 * later step could have run through it. `corepack <pm>` is not a fallback guess: corepack shipped
 * with node and does exactly what the bare binary would have, so a machine that can only reach it
 * that way is not missing the tool, only the shim. Every other place in this codebase that needs to
 * talk about a corepack-only machine (`Detection.packageManagerCommand` and its readers) points back
 * here rather than re-explaining it.
 */
function resolvedPmCommand(io: PreflightIo, packageManager: string): string | undefined {
  if (ALWAYS_PRESENT === packageManager) return packageManager;
  if (io.probe(packageManager, ['--version'])) return packageManager;
  if (io.probe(COREPACK, [packageManager, '--version'])) return `${COREPACK} ${packageManager}`;
  return undefined;
}

/** What `preflight` decided: run through `command`, or refuse with this message. */
export type PreflightResult = { refusal: string; command?: undefined } | { refusal?: undefined; command: string };

/**
 * The one place this run decides whether — and how — it can invoke the package manager.
 *
 * Resolves the invocation ONCE: earlier, `preflightRefusal` probed the machine to decide whether to
 * refuse, and callers that got past it probed AGAIN, separately, to learn what the resolved command
 * actually was — two subprocesses (the bare binary, then corepack) doing the same test twice on every
 * ordinary run. This is the single call site: it returns either the command every later step should
 * invoke, or the refusal to print, never both and never neither.
 *
 * `packageManager` is the one init RESOLVED, never a raw lockfile check. An inherited
 * `pnpm-lock.yaml` at a monorepo root does not mean the app in `frontend/` uses pnpm — that app's own
 * installed tree outranks an ancestor lockfile, and detect.ts already works this out. Re-deriving it
 * here from `exists('pnpm-lock.yaml')` refused an npm app sitting under a pnpm monorepo on a machine
 * with no pnpm, which the install gate proves must succeed.
 */
export function preflight(
  io: PreflightIo,
  packageManager: string,
  options: { alreadyServed?: boolean } = {},
): PreflightResult {
  // First: on a read-only checkout nothing else matters, and one access check is cheaper and
  // quieter than spawning a subprocess to discover the same thing.
  if (!io.canWrite()) {
    return {
      refusal:
        `${io.cwd()} is not writable, and init has to write into it (.reticle.json, the build config, ` +
        'a capabilities file). Fix the permissions, or run init from a checkout you own.',
    };
  }
  const resolved = resolvedPmCommand(io, packageManager);
  if (resolved !== undefined) return { command: resolved };
  // What the project resolves to says nothing about what the machine HAS, and a project committed to
  // pnpm on an npm-only box is an ordinary Monday.
  //
  // `alreadyServed` is `--url`. This guard exists for the DEV SERVER — to stop `spawn pnpm ENOENT`
  // surfacing inside "the dev server exited" — and `--url` says the app is already up, so init starts
  // nothing and the failure it protects against cannot happen. The dependency install can still fail
  // without the package manager (one step reporting ⚠, a better outcome than writing nothing), so a
  // command is still returned here — the bare name, since neither probe above found one — rather than
  // refusing a run that `--url` already made safe.
  if (true === options.alreadyServed) return { command: packageManager };
  return {
    refusal:
      `this project uses ${packageManager} (its lockfile says so) and ${packageManager} is not ` +
      `installed on this machine — and corepack ${packageManager} could not run it either. Install ` +
      `it (npm i -g ${packageManager}), or enable corepack for it (corepack enable — on Windows this ` +
      'needs an elevated shell), or pass --url with the address the app already serves.',
  };
}

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

/**
 * The refusal to print, or undefined when this machine can run the install.
 *
 * `packageManager` is the one init RESOLVED, never a raw lockfile check. An inherited
 * `pnpm-lock.yaml` at a monorepo root does not mean the app in `frontend/` uses pnpm — that app's own
 * installed tree outranks an ancestor lockfile, and detect.ts already works this out. Re-deriving it
 * here from `exists('pnpm-lock.yaml')` refused an npm app sitting under a pnpm monorepo on a machine
 * with no pnpm, which the install gate proves must succeed.
 */
export function preflightRefusal(
  io: PreflightIo,
  packageManager: string,
  options: { alreadyServed?: boolean } = {},
): string | undefined {
  // First: on a read-only checkout nothing else matters, and one access check is cheaper and
  // quieter than spawning a subprocess to discover the same thing.
  if (!io.canWrite()) {
    return (
      `${io.cwd()} is not writable, and init has to write into it (.reticle.json, the build config, ` +
      'a capabilities file). Fix the permissions, or run init from a checkout you own.'
    );
  }
  // What the project resolves to says nothing about what the machine HAS, and a project committed to
  // pnpm on an npm-only box is an ordinary Monday.
  //
  // `alreadyServed` is `--url`, and skipping the check for it is the message keeping its own promise.
  // This guard exists for the DEV SERVER — to stop `spawn pnpm ENOENT` surfacing inside "the dev
  // server exited" — and `--url` says the app is already up, so init starts nothing and the failure
  // it protects against cannot happen. Reported from the field as a circle: the refusal named `--url`
  // as the way past it while `--url` was being passed, because the flag was parsed and then never
  // handed to init at all.
  //
  // The dependency install can still fail without the package manager. That is one step reporting ⚠,
  // which is what a step that cannot complete is for, and is a better outcome than writing nothing:
  // the config, the connect module and `.reticle.json` all land, and the user is told the one thing
  // left to do rather than being sent to install a package manager they were trying to avoid.
  if (
    true !== options.alreadyServed &&
    ALWAYS_PRESENT !== packageManager &&
    !io.probe(packageManager, ['--version'])
  ) {
    return (
      `this project uses ${packageManager} (its lockfile says so) and ${packageManager} is not ` +
      `installed on this machine. Install it (npm i -g ${packageManager}, or corepack enable), or ` +
      'pass --url with the address the app already serves.'
    );
  }
  return undefined;
}

/**
 * What to say when the dependency install fails.
 *
 * A cohesive unit on its own: prose about one step's failure modes, and the only thing it needs is
 * which package manager was used.
 */
import { PackageManager } from '@/detect/detect.js';

/**
 * Every package manager fetches, so every one of them can fail for a reason that is nothing to do
 * with the project: offline, a proxy that blocks npmjs, a corporate mirror that is down.
 *
 * The hint used to name only version pinning and pnpm's maturity window. Both are real causes, and
 * neither is that one — so a blocked registry sent the reader through their own dependency versions
 * looking for a problem that was entirely about reachability.
 */
const REGISTRY_HINT =
  'If it could not reach the registry at all (offline, a proxy, a mirror that is down), that is ' +
  'about reachability and not about this project: check `npm config get registry` and whether this ' +
  'machine can reach it.';

/**
 * A checkout whose `node_modules` is symlinked into another checkout's `.pnpm` store — a git
 * worktree, or an A/B harness running two copies of the same repo — makes pnpm refuse to add a
 * package with ERR_PNPM_UNEXPECTED_VIRTUAL_STORE, because it will not silently repoint an
 * existing virtual store. The original hint named only the maturity-window cause, so this one
 * sent the reader through their dependency versions looking for a problem that was actually
 * about where the store lives (#683).
 */
function virtualStoreHint(pmCommand: string): string {
  return (
    "If pnpm reported ERR_PNPM_UNEXPECTED_VIRTUAL_STORE, this checkout's node_modules is " +
    "symlinked into another checkout's pnpm store (a git worktree, or an A/B harness). Either run " +
    `\`${pmCommand} install\` once in that other checkout first, or point this one at its own store:\n` +
    `  ${pmCommand} add -D --config.virtual-store-dir=node_modules/.pnpm <packages>`
  );
}

/**
 * `pm` picks which hint applies; `pmCommand` is what the reader actually types.
 *
 * A corepack-only machine (see `preflight.ts`, #1149) has no bare `pnpm` on PATH — that is the whole
 * shape of the bug this hint is used alongside. Printing `pnpm config set …` to that reader hands them
 * a command that fails the same way the original install did; `pmCommand` is the resolved invocation
 * (`corepack pnpm`, there) that is actually run on this machine.
 */
export function installFailureHint(pm: PackageManager, pmCommand: string = pm): string {
  if (pm !== PackageManager.PNPM) {
    return `If the version was refused, install the SDK yourself. ${REGISTRY_HINT}`;
  }
  return (
    'If pnpm reported ERR_PNPM_NO_MATURE_MATCHING_VERSION, its minimumReleaseAge setting is holding ' +
    'this release back. Either wait out the window, or allow these packages explicitly:\n' +
    `  ${pmCommand} config set minimumReleaseAgeExclude "@reticlehq/*"\n` +
    'Do NOT drop the version pin — unpinned, pnpm installs an older SDK against a newer daemon, and ' +
    `that mismatch surfaces as a -32000 with nothing naming a version.\n${virtualStoreHint(pmCommand)}\n${REGISTRY_HINT}`
  );
}

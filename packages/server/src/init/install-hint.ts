/**
 * What to say when the dependency install fails.
 *
 * Split out of plan.ts, which was at the 1000-line backstop. A cohesive unit rather than an
 * arbitrary cut: it is prose about one step's failure modes, and the only thing it needs is which
 * package manager was used.
 */
import { PackageManager } from './detect.js';

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
 * A `node_modules` symlinked in from another checkout — a git worktree, an A/B harness.
 *
 * pnpm refuses to add to it, because its virtual store lives in the OTHER checkout and adding here
 * would leave two trees disagreeing about one store. The hint named only the maturity window, so a
 * reader met guidance that did not fit their error and every step downstream was skipped (#683).
 *
 * The remedy is the project's, not ours: this is a statement about how the checkout is laid out, and
 * `pnpm install` in the worktree is the fix pnpm's own message is asking for.
 */
const VIRTUAL_STORE_HINT =
  "If pnpm reported ERR_PNPM_UNEXPECTED_VIRTUAL_STORE, this checkout's `node_modules` is symlinked " +
  'in from another one (a git worktree, or an A/B harness), so pnpm will not add to it. Run ' +
  '`pnpm install` in THIS directory first to give it its own store, then re-run init.';

export function installFailureHint(pm: PackageManager): string {
  if (pm !== PackageManager.PNPM) {
    return `If the version was refused, install the SDK yourself. ${REGISTRY_HINT}`;
  }
  return (
    'If pnpm reported ERR_PNPM_NO_MATURE_MATCHING_VERSION, its minimumReleaseAge setting is holding ' +
    'this release back. Either wait out the window, or allow these packages explicitly:\n' +
    '  pnpm config set minimumReleaseAgeExclude "@reticlehq/*"\n' +
    'Do NOT drop the version pin — unpinned, pnpm installs an older SDK against a newer daemon, and ' +
    `that mismatch surfaces as a -32000 with nothing naming a version.\n${VIRTUAL_STORE_HINT}\n${REGISTRY_HINT}`
  );
}

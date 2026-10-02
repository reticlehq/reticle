/**
 * The weaker install attempts, in the order they are tried.
 *
 * Ordered by how much each one gives up, cheapest concession first, because the first that succeeds
 * is the one that stands. The ladder is its own subject: two unrelated install failures, each with
 * a different cost and a different sentence to say afterwards.
 */

import { PackageManager, installCommandParts } from '@/detect/detect.js';
import type { InitIo } from '@/run-types.js';

interface InstallRetry {
  command: string;
  args: string[];
  note: string;
}

const LEGACY_PEER_DEPS = '--legacy-peer-deps';

/**
 * What the peer-conflict retry gives up, said out loud.
 *
 * npm's default peer resolution is a real check, and overriding it can leave a tree npm would not
 * have built. That is still better than no install — with no install there is no wiring at all —
 * but it is the user's tree and they get to know it was relaxed, and why we thought that was right.
 */
const LEGACY_PEER_NOTE =
  `the pinned install failed and succeeded with ${LEGACY_PEER_DEPS} — this project has a peer ` +
  'dependency conflict npm will not resolve on its own. The Reticle version is still pinned; only ' +
  'peer resolution was relaxed, and only for this install. If your project already builds with ' +
  `${LEGACY_PEER_DEPS} everywhere else this is the same tree you always get; if it does not, the ` +
  'conflict is worth looking at on its own terms.';

/**
 * Said out loud when the exact-version install failed and the unpinned one worked.
 *
 * It used to assert a cause it cannot know: every fixture app got the same sentence, blaming pnpm's
 * `minimumReleaseAge`, when the actual cause was that the version did not exist yet — and the remedy
 * offered was a `pnpm config` command handed to a yarn 1 project that will never read it.
 *
 * This note is built at PLAN time, before anything runs, and `io.exec` returns a bare boolean, so
 * the apply layer has no failure text to hand back either. The honest move is therefore to report
 * the CONSEQUENCE (which is certain and is the part that bites) and offer the remedy that belongs to
 * the manager actually in use — rather than name a cause that is one possibility among several.
 */
function unpinnedRetryNote(version: string | undefined, pm: PackageManager): string {
  const wanted = version === undefined ? 'the exact version' : version;
  // Kept verbatim for pnpm, where minimumReleaseAge is a real and common cause with a real remedy.
  const remedy =
    pm === PackageManager.PNPM
      ? ' One common cause on pnpm is minimumReleaseAge holding a new release back; if pnpm ' +
        'reported ERR_PNPM_NO_MATURE_MATCHING_VERSION, either wait out the window or allow these ' +
        'packages: pnpm config set minimumReleaseAgeExclude "@reticlehq/*"'
      : '';
  return (
    `the pinned install of ${wanted} failed, so the newest version the registry WOULD accept was ` +
    `installed instead. That may not match the daemon — if the agent reports protocol errors, check ` +
    `\`versionSkew\` in reticle_sessions.${remedy}`
  );
}

/**
 * Build the ladder for one package manager.
 *
 * `--legacy-peer-deps` is npm-only, and deliberately so: it is the only manager with the flag, and
 * pnpm, yarn and bun would reject an unknown argument — turning one failed install into two, with
 * the second failure blaming a flag the user never asked for.
 */
export function installRetries(
  pm: PackageManager,
  pinned: readonly string[],
  unpinned: readonly string[],
  sdkVersion: string | undefined,
  /**
   * The prefix that actually invokes `pm` on this machine — `pm` itself, or `corepack ${pm}` on a
   * corepack-only machine (see `preflight.ts`, #1149). A retry that spawned the bare binary here,
   * after the first attempt already went through the resolved prefix, would fail with the same
   * ENOENT the resolution exists to avoid — on the one machine shape that needs a retry to reach a
   * working install at all. Defaults to `pm` for callers that never went through preflight.
   */
  pmCommand: string = pm,
): InstallRetry[] {
  return [
    // Peers first: concedes only peer resolution and KEEPS the version pin.
    ...(pm === PackageManager.NPM
      ? [
          {
            ...installCommandParts(pm, pinned, [LEGACY_PEER_DEPS], pmCommand),
            note: LEGACY_PEER_NOTE,
          },
        ]
      : []),
    // Unpinned, last. pnpm resolves the newest MATURE version there, which is how a project with a
    // release-age hold gets a working install instead of no install.
    {
      ...installCommandParts(pm, unpinned, [], pmCommand),
      note: unpinnedRetryNote(sdkVersion, pm),
    },
  ];
}

/**
 * Yarn Berry refusing a release for being too new, told as what it is.
 *
 * Yarn 4 quarantines versions younger than its `npmMinimalAgeGate`, and answers an exact pin with
 * `All versions satisfying "<v>" are quarantined`. A Reticle release is exactly that young on the
 * day a user installs it. `init` printed "run manually: yarn add -D …", which fails the same way,
 * and the runtime then booted the app and blamed the dev server for an SDK that was never installed.
 *
 * `exec` inherits stdio so the install's progress is live, which also means its text never reaches
 * us. So on a Yarn failure the pinned command is run once more, quietly, to read why — a quarantine
 * is refused at resolution, before anything is fetched, so the second run costs well under a
 * second. Every other failure keeps the generic fallback.
 */

/** Yarn's own wording, and the environment variable that is its one-shot override. */
const QUARANTINED = /are quarantined/;
const AGE_GATE_ENV = 'YARN_NPM_MINIMAL_AGE_GATE';

export function quarantineNote(command: string): string {
  return (
    "Yarn refused the release: it is younger than Yarn's `npmMinimalAgeGate`, so every matching " +
    'version is quarantined ("are quarantined" above) and running the same command by hand fails ' +
    'the same way. Nothing was wired, so there is no app to start yet. Either wait until the ' +
    'release is older than the gate, or lift the gate for this one install and re-run init:\n\n' +
    `  ${AGE_GATE_ENV}=0 ${command}\n\n` +
    `  (PowerShell: $env:${AGE_GATE_ENV}=0; ${command})`
  );
}

/** Why the dependency install failed, when that can be read; undefined keeps the generic text. */
export function explainInstallFailure(
  io: Pick<InitIo, 'capture'>,
  packageManager: PackageManager,
  exec: { command: string; args: readonly string[] },
  display: string,
): string | undefined {
  if (PackageManager.YARN !== packageManager || io.capture === undefined) return undefined;
  const { output } = io.capture(exec.command, exec.args);
  return QUARANTINED.test(output) ? quarantineNote(display) : undefined;
}

import { describe, expect, it } from 'vitest';
import { SILENT_HOST } from './host.js';
import { runInit, type InitIo, type InitOptions } from './run.js';
import { RETICLE_VERSION } from './version.js';

/**
 * The SDK `init` installs must be the version of the Reticle that is running `init`.
 *
 * Reported from the field (#990): a daemon reporting 3.1.0 scaffolded an app with
 * `@reticlehq/react` and `@reticlehq/next` two minors behind it, on a clean install, with every
 * step green and nothing naming the disagreement. The page then never dialled the bridge, and the
 * agent was handed the version-skew remediation for a skew `init` had just created.
 *
 * The cause is a source-of-truth split. The scaffolder pinned the install to the version on its
 * OWN manifest — `@reticlehq/init`'s — and the only thing checking that against the daemon is a
 * unit test comparing two files in this repository. That is a statement about a build, not about
 * the tree a user's package manager assembled: reproduced by leaving `server/package.json` at
 * 3.1.0 and setting `init/package.json` to 2.14.0, after which `reticle --version` printed 3.1.0
 * and the very next line of `reticle init` read
 * `npm i -D @reticlehq/react@2.14.0 @reticlehq/next@2.14.0`.
 *
 * So the version is asked of the HOST, which is the daemon actually running, exactly as every
 * other thing the scaffolder cannot know for itself already is. `init-host.test.ts` on the server
 * side proves the answer that host gives is the daemon's own version; nothing over here can, which
 * is the same split of duties the pairing token has.
 */

/**
 * A release no manifest in this repository can hold, so a green cannot be a coincidence.
 *
 * Pinning the test to a real neighbouring release would pass the moment someone bumped to it.
 */
const DAEMON_RELEASE = '999.1.2';

const HOME = '/home/u';
const APP_DIR = '/app';

const NEXT_PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'shop',
    scripts: { dev: 'next dev' },
    dependencies: { next: '^15', react: '^19', 'react-dom': '^19' },
  }),
  'package-lock.json': '{}',
  'next.config.js': 'module.exports = {};\n',
  'app/layout.tsx': 'export default function L({ children }) { return children; }\n',
};

interface Recorder extends InitIo {
  readonly execCalls: { command: string; args: readonly string[] }[];
  readonly lines: string[];
}

/**
 * The smallest IO that can run a whole `init` and remember what it would have executed.
 *
 * `exec` is the assertion surface on purpose: the install command as argv is what the package
 * manager actually receives, so a pin that is right in the printed report and wrong in the call
 * cannot hide behind it.
 */
function memoryIo(releaseVersion: () => string): Recorder {
  const written: Record<string, string> = {};
  const execCalls: { command: string; args: readonly string[] }[] = [];
  const lines: string[] = [];
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const io: Recorder = {
    execCalls,
    lines,
    readFile: (p) => written[norm(p)] ?? NEXT_PROJECT[norm(p)] ?? null,
    writeFile: (p, c) => {
      written[norm(p)] = c;
    },
    exists: (p) => norm(p) in NEXT_PROJECT || norm(p) in written,
    canWrite: () => true,
    homeDir: () => HOME,
    cwd: () => APP_DIR,
    rootFiles: () => Object.keys(NEXT_PROJECT).filter((p) => !p.includes('/')),
    listDirs: (rel) => {
      const scope = '.' === rel ? '' : `${norm(rel)}/`;
      return [
        ...new Set(
          Object.keys(NEXT_PROJECT)
            .filter((p) => p.startsWith(scope) && p.slice(scope.length).includes('/'))
            .map((p) => p.slice(scope.length).split('/')[0] ?? ''),
        ),
      ].filter((n) => n !== '');
    },
    listFiles: (rel) => {
      const scope = '.' === rel ? '' : `${norm(rel)}/`;
      return Object.keys(NEXT_PROJECT)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length))
        .filter((n) => n !== '' && !n.includes('/'));
    },
    // No redirect is possible from a root that owns a package.json, so this is never reached; it
    // answers with itself rather than throwing, because a harness that can only fail one way is
    // hard to read when it does.
    scoped: () => io,
    exec: (command, args) => {
      execCalls.push({ command, args });
      return true;
    },
    probe: () => false,
    print: (line) => lines.push(line),
    host: { ...SILENT_HOST, releaseVersion },
  };
  return io;
}

const OPTS: InitOptions = {
  cwd: APP_DIR,
  port: undefined,
  // Registration writes into the developer's own home directory and has nothing to do with the
  // version the SDK is pinned at.
  mcp: false,
  dryRun: false,
  install: true,
};

/** The argv of the dependency install, which is the only exec that names an @reticlehq package. */
function installArgs(io: Recorder): readonly string[] {
  const call = io.execCalls.find((c) => c.args.some((a) => a.startsWith('@reticlehq/')));
  return call?.args ?? [];
}

describe('the SDK version init installs', () => {
  it('is the release the host reports, not the scaffolder’s own manifest', () => {
    const io = memoryIo(() => DAEMON_RELEASE);
    runInit(OPTS, io);
    expect(installArgs(io)).toContain(`@reticlehq/react@${DAEMON_RELEASE}`);
    expect(installArgs(io)).toContain(`@reticlehq/next@${DAEMON_RELEASE}`);
  });

  it('pins every Reticle package in the install to that one release', () => {
    // Half a pin is still a skew: `@reticlehq/next` resolving elsewhere is how a page loads one
    // contract while the source stamping runs on another.
    const io = memoryIo(() => DAEMON_RELEASE);
    runInit(OPTS, io);
    const reticlePackages = installArgs(io).filter((a) => a.startsWith('@reticlehq/'));
    expect(reticlePackages.length).toBeGreaterThan(0);
    for (const spec of reticlePackages) expect(spec.endsWith(`@${DAEMON_RELEASE}`)).toBe(true);
  });

  it('falls back to its own manifest when no daemon is driving the run', () => {
    // `SILENT_HOST` is the honest "nothing to report to" host — `reticle update`'s rules refresh
    // and the in-memory IOs. It has no daemon to ask, and the scaffolder's own release is the only
    // version it can truthfully name.
    const io = memoryIo(() => SILENT_HOST.releaseVersion());
    runInit(OPTS, io);
    expect(installArgs(io)).toContain(`@reticlehq/react@${RETICLE_VERSION}`);
  });

  it('does not fall back to an UNPINNED install when the host names no release', () => {
    // The failure case, and the one that must never be silent. An empty answer reaching
    // `pinnedPackages` drops the pin entirely, and an unpinned `npm i -D @reticlehq/react` is the
    // stale-resolution path the pin exists to close — it would install whatever the registry calls
    // latest, which is precisely the 2.14.0 the field reported against a 3.1.0 daemon.
    const io = memoryIo(() => '');
    runInit(OPTS, io);
    expect(installArgs(io)).toContain(`@reticlehq/react@${RETICLE_VERSION}`);
    expect(installArgs(io)).not.toContain('@reticlehq/react');
  });
});

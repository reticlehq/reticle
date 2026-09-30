/**
 * Build-time daemon discovery, and the ONE place the plugin decides which port the page dials. Finds
 * the daemon serving THIS project by reading the registry entries the daemon drops in ~/.reticle
 * (daemon-<port>.json). Node-only and
 * runs at dev-server request time (the daemon is up by then). The tricky selection rule — match by
 * projectId, drop dead daemons — is the pure `pickDaemonPort` in core; this file is just the fs plumbing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonRegistryPort,
  DaemonRegistryEntrySchema,
  pickDaemonPort,
  type DaemonRegistryEntry,
} from '@reticlehq/core';
import { stateHome } from './state-home.js';
import { readConfiguredPort } from './project-id.js';
import { RETICLE_VITE_PLUGIN_NAME } from './plugin-name.js';

/** process.kill(pid, 0) throws iff the process is gone — the same liveness probe the daemon uses. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The port of the live daemon serving `projectId`, or undefined when none matches (caller falls back
 * to the default port — never auto-connects to a mismatched daemon). `home` and `alive` are injectable
 * so the selection is unit-tested without a real ~/.reticle or real processes.
 */
export function discoverDaemonPort(
  projectId: string | undefined,
  home: string = stateHome(),
  alive: (pid: number) => boolean = isAlive,
  /** `port` in `.reticle.json`: wins whenever a live daemon is registered on it — see pickDaemonPort. */
  configured?: number,
): number | undefined {
  const entries: DaemonRegistryEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return undefined; // no ~/.reticle yet
  }
  for (const file of files) {
    if (null === daemonRegistryPort(file)) continue;
    try {
      const parsed = DaemonRegistryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(home, file), 'utf8')),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // corrupt/unreadable entry — skip
    }
  }
  return pickDaemonPort(entries, projectId, alive, configured) ?? undefined;
}

/** The three places a daemon port can come from, as the plugin sees them at connect time. */
export interface DaemonPortSources {
  /** A live daemon registered in ~/.reticle for THIS project. */
  readonly discovered: number | undefined;
  /** `port` in the nearest `.reticle.json`: the value the daemon and the CLI follow. */
  readonly configured: number | undefined;
  /** The literal `reticle({ port })`, usually written once by `reticle init`. */
  readonly explicit: number | undefined;
}

export interface DaemonPortChoice {
  /** Where to dial, or undefined for the default port. */
  readonly port: number | undefined;
  /** Set only when the option and `.reticle.json` disagree: one line naming both and the winner. */
  readonly warning: string | undefined;
}

const portConflictWarning = (explicit: number, configured: number, used: number): string =>
  `[${RETICLE_VITE_PLUGIN_NAME}] reticle({ port: ${String(explicit)} }) and "port": ` +
  `${String(configured)} in .reticle.json disagree; connecting to ${String(used)}. The daemon and ` +
  'the CLI follow .reticle.json, so drop the port option from reticle() or make the two match.';

/**
 * The one rule for which port the page dials: wherever the daemon for this project actually is.
 *
 * A live registered daemon first, because it is a fact rather than a statement of intent — and when
 * one is live on the configured port, that one (see pickDaemonPort: a moved port left the old daemon
 * alive, and discovery used to pick it). Then
 * `.reticle.json`, because that is what the daemon and the CLI read. The option used to win, and a
 * user who edited the file moved the daemon while the page kept dialling the literal `init` had
 * written into vite.config: "never dialled the bridge", with nothing saying why. The option counts
 * only when nothing else says anything, and undefined leaves the default to the connect.
 */
export function chooseDaemonPort(sources: DaemonPortSources): DaemonPortChoice {
  const { discovered, configured, explicit } = sources;
  const port = discovered ?? configured ?? explicit;
  if (explicit === undefined || configured === undefined || port === undefined) {
    return { port, warning: undefined };
  }
  return {
    port,
    warning: explicit === configured ? undefined : portConflictWarning(explicit, configured, port),
  };
}

/** {@link chooseDaemonPort} over the real registry and the real `.reticle.json` above `cwd`. */
export function resolveDaemonPort(
  explicit: number | undefined,
  projectId: string | undefined,
  cwd: string,
): DaemonPortChoice {
  const configured = readConfiguredPort(cwd);
  return chooseDaemonPort({
    discovered: discoverDaemonPort(projectId, stateHome(), isAlive, configured),
    configured,
    explicit,
  });
}

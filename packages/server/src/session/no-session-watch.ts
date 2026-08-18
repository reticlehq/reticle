/**
 * Keeps the "why is nothing connected" diagnosis fresh, without putting a probe on the hot path.
 *
 * `SessionManager.resolve` is synchronous and runs on every tool call, so it cannot await a port
 * scan. This refreshes the answer in the background and hands the manager a closure that reads the
 * cached result — a hint in an error message is exactly the sort of thing that may be a few seconds
 * stale.
 *
 * It only probes while NOTHING is connected. Once a session is live the question is moot, and a
 * daemon that outlives the agent by hours has no business scanning ports it does not need.
 */

import { probeDevServers } from './dev-server-probe.js';
import { diagnoseNoSession } from './no-session-diagnosis.js';
import { readProjectPort } from '../cli/cli-port.js';
import { discoverConfigs } from '../cli/config-discovery.js';
import type { SessionManager } from './session-manager.js';

/** Slow enough to be free, fast enough that a dev server started 15s ago is already reflected. */
const REFRESH_MS = 15_000;

interface NoSessionWatchOptions {
  sessions: SessionManager;
  port: number;
  /** Whether this project has been through `reticle init` (a projectId is stamped in .reticle.json). */
  initialized: boolean;
  /** Where that was decided — this daemon's working directory unless a caller says otherwise. */
  directory?: string;
  probe?: () => Promise<number[]>;
  /**
   * How many pooled leases have aged out, if a pool exists. Injected as a reader rather than the
   * pool itself: the diagnosis needs one number, and taking the whole pool would tie the session
   * layer to the browser layer for it.
   */
  reapedLeases?: () => number;
}

/** Start the watch. Returns a stop function; the timer is unref'd so it never holds the daemon up. */
function startNoSessionWatch(options: NoSessionWatchOptions): () => void {
  const probe = options.probe ?? (() => probeDevServers());
  let listening: readonly number[] = [];
  let running = false;

  const refresh = (): void => {
    // Nothing to diagnose while a session is live, and no reason to scan.
    if (running || options.sessions.count() > 0) return;
    running = true;
    void probe()
      .then((ports) => {
        listening = ports;
      })
      .catch(() => {
        /* a diagnostic hint must never take the daemon down */
      })
      .finally(() => {
        running = false;
      });
  };

  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();

  options.sessions.setNoSessionHint(() =>
    diagnoseNoSession({
      everConnected: options.sessions.everConnected(),
      initialized: options.initialized,
      listening,
      port: options.port,
      // The directory `initialized` was decided in. Named in the message because "there is no
      // `.reticle.json`" is a claim about ONE directory, and a reader standing somewhere else
      // cannot tell whether it is a claim about their app at all.
      directory: options.directory ?? process.cwd(),
      leaseExpired: (options.reapedLeases?.() ?? 0) > 0,
      // Read here rather than at boot: `.reticle.json` can be written by `init` after this daemon
      // started, which is the ordinary first-install order, and a port cached from before it existed
      // would make the daemon confidently report no mismatch on the one run where there is one.
      ...(() => {
        const configured = readProjectPort(options.directory ?? process.cwd());
        return configured === undefined ? {} : { projectPort: configured };
      })(),
      // Searched here rather than at boot, for the same reason as the port above: `init` can write
      // the config after this daemon started. Cheap enough to redo per hint — it stats a handful of
      // directories, and only ever runs while building an error message.
      ...(() => {
        const { configs, searched } = discoverConfigs(options.directory ?? process.cwd());
        return { discoveredConfigs: configs, searchedDirectories: searched };
      })(),
    }),
  );

  return () => {
    clearInterval(timer);
    options.sessions.setNoSessionHint(undefined);
  };
}

/**
 * The daemon's whole session-scoping decision in one call: scope auto-selection to the active
 * project, and keep the no-session diagnosis fresh. Both derive from the same one fact — whether
 * this directory has been through `reticle init` — so they belong together rather than as two
 * adjacent blocks in the bootstrap.
 */
export function wireSessionScope(
  sessions: SessionManager,
  activeProjectId: string | undefined,
  port: number,
  /** Reader for the pool's aged-out-lease count; omitted when this daemon runs no pool. */
  reapedLeases?: () => number,
): () => void {
  if (activeProjectId !== undefined) sessions.setDefaultScope({ projectId: activeProjectId });
  return startNoSessionWatch({
    sessions,
    port,
    initialized: activeProjectId !== undefined,
    ...(reapedLeases === undefined ? {} : { reapedLeases }),
  });
}

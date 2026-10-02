/**
 * Making sure something is listening before the app is asked to dial it.
 *
 * The setup phases wait for the page to appear as a session, which cannot happen unless a daemon
 * holds the bridge port. Nothing in `init` started one. On a developer machine that is invisible,
 * because an editor running `reticle mcp` has had a daemon up for hours; on a machine installing
 * Reticle for the first time, which is every machine this command exists for, there is nothing to
 * dial and setup ends with "the SDK is in the page and never dialled the bridge" — the SDK being
 * blamed for the absence of the thing it was dialling.
 *
 * Idempotent by construction: a daemon that speaks our wire contract is adopted. One that does NOT
 * is not usable, however healthy its `/status`: an older Reticle turns away every hello from the page
 * init just instrumented ("bridge refused the connection: invalid message"), and init used to adopt
 * it anyway, wait out its budget, and blame the page. So a skewed daemon nobody is using is replaced
 * (stopped by its LISTENER, never `lsof -ti`, which also kills the agent's MCP proxy), and one with
 * live sessions is left alone with the exact command to run once they are done.
 *
 * A stranger on the port that is not a Reticle daemon at all is refused before this runs; see
 * `bridge-port.ts`.
 */

import { log } from '@/log.js';
import { isAlive, readPid, reticleStateHome, spawnDaemon } from '@/command/daemon/daemon.js';
import { readDaemonRegistry } from '@/command/daemon/daemon-resolve.js';
import { LOOPBACK_HOST, STATUS_HOLD_MS } from '@reticlehq/core';
import { probePresence, presenceIsUsable } from '@/command/daemon/binding/port-presence.js';
import { probeDaemon, waitForDaemonBind } from '@/surface/mcp/mcp-proxy.js';
import { daemonSpawnArgs } from '@/command/cli/daemon-start-options.js';
import { fetchStatus, summarizeStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { runKill } from '@/command/cli/cli-kill.js';
import type { DaemonRegistryEntry } from '@reticlehq/core/artifacts';

interface EnsureDaemonDeps {
  /**
   * Whether a daemon's `/status` body says it speaks a different wire contract from this build.
   * Injected: the judge is `daemonSkew` in cli-launch, the same rule `reticle mcp` warns with.
   */
  readonly skewed: (status: unknown) => boolean;
  readonly usable: (port: number) => Promise<boolean>;
  /** The daemon's `/status` body, or undefined. */
  readonly status: (port: number) => Promise<unknown>;
  /** Stop the daemon on the port. True once the port is free. */
  readonly replace: (port: number) => Promise<boolean>;
  readonly spawn: (port: number) => boolean;
  /**
   * A live process already owns this port's pid file — a daemon mid-start that this spawn lost the
   * lock to. That is exactly what `spawn` returning false means on a fresh HOME where the editor's
   * `reticle mcp` got there first, and it is a reason to wait, not to give up.
   */
  readonly starting: (port: number) => boolean;
  readonly waitReady: (port: number) => Promise<unknown>;
  readonly scriptPath: string | undefined;
}

export const EnsureDaemon = {
  /** Something usable was already there. */
  ADOPTED: 'adopted',
  STARTED: 'started',
  /** A daemon on another wire contract, serving nobody, was stopped and ours started in its place. */
  REPLACED: 'replaced',
  /** A daemon on another wire contract is serving live sessions, so it was left alone. */
  SKEWED_IN_USE: 'skewed-in-use',
  /** Could not be started, and the caller has to say so rather than blame the page. */
  UNAVAILABLE: 'unavailable',
} as const;
export type EnsureDaemon = (typeof EnsureDaemon)[keyof typeof EnsureDaemon];

interface EnsureDaemonResult {
  readonly state: EnsureDaemon;
  /** One line for the person watching, when the state needs one. */
  readonly message?: string;
}

/** A string field off the /status body, or undefined on a daemon too old to report it. */
function statusString(payload: unknown, key: string): string | undefined {
  if ('object' !== typeof payload || null === payload) return undefined;
  const value: unknown = Reflect.get(payload, key);
  return 'string' === typeof value && 0 < value.length ? value : undefined;
}

async function spawnAndWait(port: number, deps: EnsureDaemonDeps): Promise<boolean> {
  if (undefined === deps.scriptPath) return false;
  // A lost spawn race is not a failed start: `init` printed "could not start the Reticle daemon"
  // over a daemon that bound seconds later. Only a spawn that failed with nobody else starting one
  // is a reason to stop without waiting.
  if (!deps.spawn(port) && !deps.starting(port)) return false;
  try {
    // Readiness means the port ACCEPTS, not that a child was spawned: a readiness signal that
    // precedes readiness is worse than none, because what waits on it stops waiting too early.
    await deps.waitReady(port);
  } catch {
    return false;
  }
  return deps.usable(port);
}

export async function ensureDaemon(
  port: number,
  deps: EnsureDaemonDeps,
): Promise<EnsureDaemonResult> {
  if (await deps.usable(port)) {
    const status = await deps.status(port);
    if (!deps.skewed(status)) return { state: EnsureDaemon.ADOPTED };
    const theirs = statusString(status, 'version') ?? 'an older build';
    const { sessionCount } = summarizeStatus(status);
    if (0 < sessionCount) {
      return {
        state: EnsureDaemon.SKEWED_IN_USE,
        message:
          `The Reticle daemon on port ${String(port)} is ${theirs}, which speaks a different wire ` +
          `contract than this init, so it will refuse your app — and ` +
          `${String(sessionCount)} session(s) are still using it, so init will not stop it. When ` +
          `they are done, run \`npx @reticlehq/server kill --port ${String(port)}\` and re-run init.`,
      };
    }
    if (!(await deps.replace(port))) return { state: EnsureDaemon.UNAVAILABLE };
    return (await spawnAndWait(port, deps))
      ? {
          state: EnsureDaemon.REPLACED,
          message:
            `replaced the idle Reticle daemon on port ${String(port)} (${theirs}), which speaks a ` +
            `different wire contract and would have refused your app, with a current one.`,
        }
      : { state: EnsureDaemon.UNAVAILABLE };
  }
  return (await spawnAndWait(port, deps))
    ? { state: EnsureDaemon.STARTED }
    : { state: EnsureDaemon.UNAVAILABLE };
}

interface RetireDeps {
  /** Every LIVE daemon in the registry. */
  readonly registered: () => readonly DaemonRegistryEntry[];
  readonly status: (port: number) => Promise<unknown>;
  /** Stop the daemon on the port by its listener. True once the port is free. */
  readonly stop: (port: number) => Promise<boolean>;
}

/**
 * Stop this project's daemons on any port but `port`, the one init is about to use. Returns the
 * ports stopped.
 *
 * `init --port <new>` started a daemon on the new port and left the old one serving: the build
 * plugin found both, dialled the old one, and init — waiting on the new one — exited 1 with
 * "connected to a DIFFERENT Reticle daemon". A daemon another project's tab is still on is left
 * alone, because stopping it would take that app down to fix this one. Stopped by its listener
 * (`runKill` without force), never `lsof -ti`, which also kills the agent's MCP proxy.
 */
export async function retireMovedDaemons(
  projectId: string | undefined,
  port: number,
  deps: RetireDeps,
): Promise<number[]> {
  if (undefined === projectId || 0 === projectId.length) return [];
  const stopped: number[] = [];
  for (const entry of deps.registered()) {
    if (entry.projectId !== projectId || entry.port === port) continue;
    const { sessions } = summarizeStatus(await deps.status(entry.port));
    const shared = sessions.some((s) => undefined !== s.projectId && projectId !== s.projectId);
    if (shared) continue;
    if (await deps.stop(entry.port)) stopped.push(entry.port);
  }
  return stopped;
}

/** The real registry, `/status` and listener-only stop. */
export function nodeRetireDeps(): RetireDeps {
  return {
    registered: () => readDaemonRegistry(reticleStateHome()).filter((e) => isAlive(e.pid)),
    status: (port) => fetchStatus(port),
    stop: (port) => runKill(port, false),
  };
}

/**
 * Hold the daemon on `port` until the returned release is called, by renewing a hold on its
 * `/status` well inside the hold window.
 *
 * `init` starts the daemon and can then wait on the app for longer than the idle grace — a cold
 * desktop build, a slow first compile. None of that counted as activity, and the daemon init had
 * just started idled out (`reticle_daemon_idle_exit`) while init was still waiting on it.
 */
export function holdDaemon(port: number): () => void {
  const renew = (): void => void fetchStatus(port, LOOPBACK_HOST, true);
  renew();
  const timer = setInterval(renew, STATUS_HOLD_MS / 3);
  timer.unref();
  return () => clearInterval(timer);
}

export function nodeEnsureDaemonDeps(skewed: (status: unknown) => boolean): EnsureDaemonDeps {
  return {
    skewed,
    usable: async (port: number): Promise<boolean> =>
      presenceIsUsable(await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus })),
    status: (port: number): Promise<unknown> => fetchStatus(port),
    // `reticle kill` without `--force`: it signals only the LISTENER, and only one that answers
    // /status, so the agent's MCP proxy on the same port survives.
    replace: (port: number): Promise<boolean> => runKill(port, false),
    spawn: (port: number): boolean => {
      const scriptPath = process.argv[1];
      if (undefined === scriptPath) return false;
      const started = spawnDaemon(
        process.execPath,
        scriptPath,
        daemonSpawnArgs({ port, headless: true, http: false }),
        port,
      );
      // For a log or a pipe. On a terminal it was a JSON line in the middle of `init`'s output, read
      // by a person, about a step the next lines already report in words.
      if (true !== process.stderr.isTTY) log('reticle_setup_daemon_started', { port, started });
      return started;
    },
    starting: (port: number): boolean => {
      const pid = readPid(port);
      return null !== pid && isAlive(pid);
    },
    // The same wait `reticle restart` does: poll until `/status` answers as a daemon, bounded. A
    // cold daemon on a fresh HOME outlived the proxy's shorter reconnect budget this used to borrow.
    waitReady: async (port: number): Promise<unknown> => {
      if (!(await waitForDaemonBind(port))) throw new Error(`no daemon bound :${String(port)}`);
      return undefined;
    },
    scriptPath: process.argv[1],
  };
}

/**
 * `reticle mcp` — the process an editor launches, and the one whose failure a user experiences as
 * "the MCP server disconnected".
 *
 * Split out of `cli.ts` when that file passed the 1000-line backstop. It earns its own module rather
 * than being an arbitrary slice: everything here is about ONE decision — which daemon this agent
 * talks to for the rest of its life — and the port resolution at the top is the fix for agents on
 * different projects silently sharing one daemon, one identity and one blast radius.
 */

import { log } from '@/log.js';
import { isAlive, spawnDaemon, reticleStateHome } from '@/command/daemon/daemon.js';
import {
  PortPresence,
  probePresence,
  presenceIsUsable,
} from '@/command/daemon/binding/port-presence.js';
import { describePortState } from '@/command/daemon/port-state.js';
import {
  waitForDaemon,
  startMcpProxy,
  probeDaemon,
  proxyLog,
  setProxyLogPort,
  flushProxyExit,
  reportWakeRefused,
} from '@/surface/mcp/mcp-proxy.js';
import { installProxyResilience } from '@/command/daemon/daemon-resilience.js';
import { readProjectId, readProjectPort } from './ports/resolve/cli-port.js';
import {
  resolveMcpPort,
  daemonProjectAt,
  relocationReason,
} from '@/command/daemon/daemon-resolve.js';
import { daemonSpawnArgs } from './daemon-start-options.js';
import { WakeAction, decideWake } from '@/command/daemon/wake-decision.js';
import { runKill, stopWedgedDaemon } from './cli-kill.js';
import { pickDaemonPortToBind } from '@/command/daemon/binding/free-port.js';
import { fetchStatus, summarizeStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { isNewerVersion } from '@/command/update/update-nudge.js';
import { migrateApprovals } from '@/command/setup/approval-migration.js';
import { ProxyExitReason, ReticleEnv, WakeRefusalPresence } from '@reticlehq/core';
import { agentIo } from '@/command/setup/agent-io.js';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';
import { homedir } from 'node:os';
import { platformKey } from '@/command/setup/agent-configs.js';

/**
 * Whether the daemon this proxy starts hides its browser. A daemon on a port nobody chose — the
 * requested one served another project, so this one was moved — was opening a visible browser the
 * person never asked for, on a port nothing records. Only the requested port gets the default.
 */
export function spawnsHeadless(headless: boolean, requested: number, resolved: number): boolean {
  return headless || requested !== resolved;
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+/;
/** The first release whose `/status` names the agents attached to it (`mcpPeers`). */
const MCP_PEERS_SINCE = '3.6.0';

/**
 * Should a proxy stop the older daemon it found, and start its own release?
 *
 * Only an OLDER daemon, read from `/status`, with no tab attached and no other agent attached. A
 * tab or an agent can have a call in flight, so that daemon stays and the skew is described as
 * before. A daemon before `MCP_PEERS_SINCE` does not report its agents, so it stays too. A status
 * that does not parse, or a version that does not compare, keeps the daemon.
 */
export function retiresOlderDaemon(status: unknown, proxyVersion: string): boolean {
  if (typeof status !== 'object' || null === status) {
    return false;
  }
  const fields = status as Record<string, unknown>;
  const version = fields['version'];
  if ('string' !== typeof version) {
    return false;
  }
  // Only a plain release number compares; anything else keeps the daemon.
  if (!RELEASE_VERSION.test(version) || !isNewerVersion(proxyVersion, version)) {
    return false;
  }
  // An older daemon never sends `mcpPeers`, so it cannot say that no agent is attached.
  if (isNewerVersion(MCP_PEERS_SINCE, version)) {
    return false;
  }
  const peers = fields['mcpPeers'];
  // A daemon sends `mcpPeers` only when an agent is attached.
  if (Array.isArray(peers) && 0 < peers.length) {
    return false;
  }
  return 0 === summarizeStatus(status).sessionCount;
}

/**
 * MCP proxy mode: ensures the daemon is running, then bridges Claude Code's
 * stdin/stdout to the daemon's SSE endpoint. This is the recommended way to
 * configure Reticle in.mcp.json — users never need to manage the daemon manually.
 *
 * Pass --drive <url> to have the daemon launch its own Playwright browser at that
 * URL. The agent then has full autonomous control without relying on the user's browser.
 */
export async function handleMcp(opts: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): Promise<void> {
  const { driveUrl, headless, http, httpPort, httpToken } = opts;
  // Decided before anything else, because every line below is about ONE port and the wrong one means
  // serving another project's daemon. `resolveMcpPort` prefers our own daemon wherever it moved to,
  // takes the requested port when it is free or unclaimed, and relocates to an OS-assigned port
  // rather than adopting a daemon that belongs to somebody else.
  //
  // The reconnect path keeps one port. Only a WAKE, which already starts from a dormant proxy,
  // resolves again and moves the proxy: see `ensure`. The reconnect path is the one piece whose
  // failure reads to a user as "the MCP server disappeared mid-session", so it does not chase.
  // Read once and reused by the wake path below: the boot resolution and every later wake must be
  // defending the SAME identity, and computing it twice is how they drift apart.
  // Before the port work, because it is the only moment we are guaranteed to get on a machine that
  // installed Reticle before the pre-approval rules existed. Once per version, never a create that
  // supersedes an allowlist we cannot read, and it cannot throw: see approval-migration.
  // A sandboxed state dir means a test, a gate or a fixture, none of which are asking us to rewrite
  // the real user's editor configuration.
  if (undefined === process.env[ReticleEnv.STATE_DIR]) {
    migrateApprovals({
      io: agentIo,
      home: homedir(),
      platform: platformKey(process.platform),
      stateHome: reticleStateHome(),
      version: SERVER_VERSION,
      log,
    });
  }

  const projectId = readProjectId(process.cwd());
  const resolvePort = (): Promise<number> =>
    resolveMcpPort(
      opts.port,
      projectId,
      reticleStateHome(),
      {
        alive: isAlive,
        daemonPresent: async (p: number): Promise<boolean> =>
          presenceIsUsable(await probePresence(p, { tcpOpen: probeDaemon, status: fetchStatus })),
        pickPort: (p: number): Promise<number> => pickDaemonPortToBind(p),
      },
      readProjectPort(process.cwd()),
    );
  const noteRelocated = (to: number): void => {
    log('reticle_mcp_port_relocated', {
      requested: opts.port,
      port: to,
      reason: relocationReason(opts.port, to, projectId, reticleStateHome(), isAlive),
    });
  };
  // A Reticle daemon stuck on the requested port is stopped, not moved away from: the app's SDK
  // dials this port, and a daemon on another one gets no page (#1937).
  await stopWedgedDaemon(opts.port);
  // `let`: a wake that finds the port taken resolves again, and the proxy follows (#1651, #1652).
  let port = await resolvePort();
  if (port !== opts.port) {
    noteRelocated(port);
  }
  // The proxy IS the MCP server the editor launched. Nothing respawns it, so an uncaught throw here
  // is what a user experiences as "the MCP server disconnected — open /mcp and reconnect". Log it,
  // report it, keep serving: the reconnect and dormant paths already know how to rebuild the only
  // state this process has. See installProxyResilience for why its rule inverts the daemon's.
  // The proxy's crash handlers must write to the proxy's LOG FILE, not just stderr. The editor
  // swallows stderr, so wiring these to `log` meant a crash was handled and then unrecorded — the
  // failure a user reports as "it disconnected" left nothing behind to read.
  setProxyLogPort(port);
  // The storm exit is a proxy exit too: report it before the process goes.
  // Only the client pipes count toward the storm exit; see installProxyResilience.
  const resilience = installProxyResilience(
    process,
    proxyLog,
    undefined,
    () => {
      void flushProxyExit(ProxyExitReason.CLIENT_GONE_STORM).finally(() => process.exit(0));
    },
    [process.stdin, process.stdout],
  );
  /**
   * Make sure a daemon is on the port, spawning one if not.
   *
   * Called on first start AND on every reconnect. The proxy used to only retry the socket, so a
   * daemon that exited — crashed, `reticle stop`, or self-shut-down as idle — meant the retries hit
   * a dead port until the budget ran out and the agent's MCP server exited with it. Reticle simply
   * disappeared mid-session with nothing said. Respawning here makes the reconnect self-healing.
   */
  // Resolved when a new daemon process starts, so the proxy can answer the handshake at once.
  let markSpawning: () => void = () => undefined;
  const spawning = new Promise<void>((resolve) => (markSpawning = resolve));
  const ensure = async (mayRelocate = true): Promise<number> => {
    // The same question every other surface asks. It used to be a bare TCP connect, so a stranger on
    // the bridge port answered "a daemon is here" — the proxy connected, the stream ended, and each
    // client request woke into the identical non-answer. Rejecting here is what puts the proxy
    // dormant with a reason, instead of pretending the wake succeeded.
    let presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
    // A Reticle daemon that holds the port and does not answer: stop it and keep the port, as at
    // boot. Relocating left the app dialling a port with no working daemon (#1937).
    if (PortPresence.FOREIGN === presence && (await stopWedgedDaemon(port))) {
      presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
    }
    // Identity, not just presence. `resolveMcpPort` above already refuses to adopt a stranger's
    // daemon at boot; this is the same question asked on every WAKE, which is where it was missing.
    //
    // Reachable by ordinary use, with no error anywhere: a daemon retires on its idle timer and
    // frees the port, another project's daemon binds it, and this project's dormant proxy wakes
    // straight onto it. The agent then drives, asserts and reports a verdict about a DIFFERENT
    // APPLICATION. That is worse than the disconnect it was reintroduced under the cover of, because
    // a disconnect is visible and this is a false green wearing a valid session.
    const wake = decideWake(presence, daemonProjectAt(port, reticleStateHome()), projectId);
    if (WakeAction.USE === wake) {
      // A proxy from a newer release stops an older daemon that nobody is using, and starts its own.
      // Otherwise every tool refused on the skew until a person ran `reticle restart`.
      const status = await fetchStatus(port);
      if (!retiresOlderDaemon(status, SERVER_VERSION)) {
        return port;
      }
      log('reticle_mcp_retiring_older_daemon', { port, proxyVersion: SERVER_VERSION });
      // Not stopped: use it. The daemon describes the skew to this agent, as before.
      if (!(await runKill(port, false))) {
        return port;
      }
    }
    if (WakeAction.REFUSE === wake && mayRelocate) {
      // Somebody else took the port after our daemon left it. Resolve again, as at boot: our own
      // daemon wherever it moved, else a free port. Once per wake, so it cannot loop.
      const moved = await resolvePort();
      if (moved !== port) {
        noteRelocated(moved);
        port = moved;
        setProxyLogPort(port);
        return ensure(false);
      }
    }
    if (WakeAction.REFUSE === wake) {
      void reportWakeRefused(
        PortPresence.DAEMON === presence
          ? WakeRefusalPresence.OTHER_PROJECT
          : WakeRefusalPresence.FOREIGN,
      );
      throw new Error(
        PortPresence.DAEMON === presence
          ? `the daemon on port ${String(port)} belongs to a different project, so this one will ` +
              'not adopt it. Stop it, or start this project on its own port.'
          : describePortState(presence, port),
      );
    }
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) {
      log('reticle_mcp_no_script', {});
      await flushProxyExit(ProxyExitReason.WAKE_FAILED);
      process.exit(1);
    }
    const daemonArgs = daemonSpawnArgs({
      port,
      headless: spawnsHeadless(headless, opts.port, port),
      http,
      ...(driveUrl !== undefined ? { driveUrl } : {}),
      ...(httpPort !== undefined ? { httpPort } : {}),
      ...(httpToken !== undefined ? { httpToken } : {}),
    });
    markSpawning();
    spawnDaemon(process.execPath, scriptPath, daemonArgs, port);
    // Announce the daemon only once the PORT ACCEPTS. This line used to be written the instant the
    // child was spawned, which on a Windows first bootstrap meant `reticle_mcp_daemon_started`
    // followed about ten seconds later by `reticle_mcp_daemon_unavailable` and a first
    // `reticle_sessions` that expired. A readiness signal that precedes readiness is worse than
    // none: a client that believes it stops waiting for the thing that has not happened.
    await waitForDaemon(port);
    log('reticle_mcp_daemon_started', { port, ...(driveUrl !== undefined ? { driveUrl } : {}) });
    return port;
  };
  // Start the proxy WHATEVER happened to the daemon.
  //
  // This used to exit(1) when `ensure` failed, which is the third way an MCP server disappears on a
  // user: something else is holding the bridge port — a foreign daemon from another project, a
  // half-dead process, a port a colleague's tool grabbed — the spawned daemon cannot bind, and the
  // editor shows a server that failed to start. Nothing about that is unrecoverable: the proxy
  // answers `initialize` itself, serves the cached catalog, and its wake path retries a daemon on
  // every client request. Present-and-complaining beats absent, because absent needs a human.
  //
  // The proxy starts NOW, beside the daemon start, and dials when the start is done. A client that
  // does not wait for MCP servers gets the handshake and the tool list before the daemon is up.
  const ready = ensure().catch((err: unknown) => {
    log('reticle_mcp_daemon_unavailable', {
      error: err instanceof Error ? err.message : String(err),
      note: 'serving anyway — the next tool call will try to start a daemon again',
    });
  });
  // Also `void`: the proxy runs for the life of the process and is never awaited by anyone.
  //
  // The `.catch` is load-bearing despite that. `startMcpProxy` rejects when its FIRST connect
  // fails — which is precisely the case this block exists to tolerate, a daemon that is not
  // there yet — and with nothing attached that reject became an unhandledRejection. Reported
  // from a win32 user as a crash reading `connect ECONNREFUSED` with an EMPTY frame list,
  // because the stack of a refused socket is entirely node internals and the privacy filter
  // keeps only Reticle frames. So the one path we most want diagnosable arrived as an anonymous
  // crash. The proxy itself is unaffected — it has already installed its stdin reader and goes
  // on serving from cache, waking a daemon on the next request — which is exactly why this
  // must be logged as the expected condition it is rather than reported as a defect.
  void startMcpProxy(
    port,
    ensure,
    undefined,
    () => {
      resilience.noteUsableSession();
    },
    {
      ready,
      spawning,
      // Loaded only when needed: the tool table is large, and a warm start never uses it.
      tools: async () => {
        const [{ staticToolCatalog }, { resolveToolSurface }] = await Promise.all([
          import('@/surface/mcp/mcp.js'),
          import('@/surface/tools/tool-surface.js'),
        ]);
        return staticToolCatalog(resolveToolSurface());
      },
    },
  ).catch((err: unknown) => {
    log('reticle_mcp_proxy_first_connect_failed', {
      port,
      error: err instanceof Error ? err.message : String(err),
      note: 'serving from cache; the next client request will try to start a daemon',
    });
  });
}

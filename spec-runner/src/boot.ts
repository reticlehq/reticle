import { join } from 'node:path';
import { ReticleDir, RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import {
  AnnotationStore,
  BaselineStore,
  FlowStore,
  ProjectStore,
  RecordingStore,
  createNodeFileSystem,
  createToolInvoker,
  start,
  PortPresence,
  probePresence,
  probeDaemon,
  fetchStatus,
} from '@reticlehq/server';
import type { RunningServer, ToolDeps, ToolInvoker } from '@reticlehq/server';

export interface BootedRun {
  invoke: ToolInvoker;
  close: () => Promise<void>;
}

export interface BootOptions {
  /** URL the headless real-input browser navigates to (sets inputMode:'real' for pointer acts). */
  driveUrl: string;
  /** Launch headless (default true). */
  headless?: boolean;
  port?: number;
  /** Absolute .reticle root. Defaults to cwd()/.reticle. Injectable for tests. */
  reticleRoot?: string;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
  /** Injectable ToolDeps builder so tests can wire a fake server without real IO. */
  buildDeps?: (server: RunningServer) => ToolDeps;
}

/**
 * Build ToolDeps from a started server (Option b: zero further server changes). The only place
 * in @reticlehq/test that touches real IO — and it does so only by delegating to @reticlehq/server's start.
 */
function defaultBuildDeps(server: RunningServer, opts: BootOptions): ToolDeps {
  const fs = createNodeFileSystem();
  const reticleRoot = opts.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT);
  const now = opts.now ?? ((): number => Date.now());
  const base = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, reticleRoot, { now }),
    project: new ProjectStore(fs, reticleRoot, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot,
    now,
  };
  return server.realInput !== undefined ? { ...base, realInput: server.realInput } : base;
}

/**
 * One sentence for a port a Reticle daemon already owns: names the port, says who holds it,
 * and offers the two ways out. `reticle serve` and `bootSession` share the default port, so
 * this is the normal state on a set-up machine, not a fault.
 */
function daemonOwnsPortMessage(port: number): string {
  return (
    `Port ${String(port)} is already owned by a Reticle daemon (` +
    '`reticle serve` is running). Pass a different `port` to `bootSession`, ' +
    'or run `reticle stop` first.'
  );
}

/**
 * One sentence for the bind race the probe cannot close: something grabbed the port between
 * the probe and `start()`. Names the port and the `port` option, never the raw EADDRINUSE.
 */
function portBusyMessage(port: number): string {
  return (
    `Port ${String(port)} is already in use — another process grabbed it. ` +
    'Pass a different `port` to `bootSession`, or stop the process holding the port ' +
    '(`reticle stop` if it is a Reticle daemon) and retry.'
  );
}

/** True when the error is node's bind collision, the race the pre-start probe cannot close. */
function isAddrInUse(error: unknown): boolean {
  if ('object' !== typeof error || null === error) return false;
  if (!('code' in error)) return false;
  const code: unknown = error.code;
  return 'EADDRINUSE' === code;
}

/**
 * Production wiring: launch a headless real-input browser against `driveUrl`, then expose a
 * programmatic ToolInvoker over it (no MCP/stdio). Tests inject a fake invoker into runSpecs
 * directly and never reach this path.
 */
export async function bootSession(opts: BootOptions): Promise<BootedRun> {
  const port = opts.port ?? RETICLE_DEFAULT_PORT;
  // Probe before binding: `reticle serve` defaults to the same port, so a daemon owning it is
  // the normal state, and the raw `listen EADDRINUSE` from `node:net` says nothing about that.
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (presence === PortPresence.DAEMON) {
    throw new Error(daemonOwnsPortMessage(port));
  }
  const startOptions = {
    mcp: false as const,
    driveUrl: opts.driveUrl,
    headless: opts.headless ?? true,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  };
  let server: RunningServer;
  try {
    server = await start(startOptions);
  } catch (error) {
    // The race the probe cannot close: something bound the port after the probe ran.
    if (isAddrInUse(error)) {
      throw new Error(portBusyMessage(port));
    }
    throw error;
  }
  const deps = (opts.buildDeps ?? ((s) => defaultBuildDeps(s, opts)))(server);
  return { invoke: createToolInvoker(deps), close: server.close };
}

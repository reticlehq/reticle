import { join } from 'node:path';
import { ReticleDir, RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import {
  AnnotationStore,
  BaselineStore,
  FlowStore,
  ProjectStore,
  RecordingStore,
  PortPresence,
  createNodeFileSystem,
  createToolInvoker,
  describePresence,
  fetchStatus,
  probeDaemon,
  probePresence,
  start,
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
 * The clear refusal `bootSession` throws instead of a raw `node:net` stack (reticlehq/reticle#1141).
 * Names the port, folds in the CLI's own sentence for WHY it's unusable (`describePresence`), and —
 * unlike `describePresence` alone, which only spells out `reticle stop` for a few of its branches —
 * always states both ways out explicitly: a different `port` to `bootSession`, or `reticle stop`.
 * This is the normal state on any machine that already has `reticle serve` running, since both
 * default to the same port.
 */
function portTakenError(port: number, presence: PortPresence): Error {
  return new Error(
    `bootSession can't use port ${String(port)} — ${describePresence(presence, port)} ` +
      'Pass a different `port` to bootSession, or run `reticle stop` to free this one.',
  );
}

/** The one Node error `start()` can still surface for a port `probePresence` just called FREE. */
function isPortRaceLoss(error: unknown): boolean {
  return error instanceof Error && 'EADDRINUSE' === (error as NodeJS.ErrnoException).code;
}

/**
 * Production wiring: launch a headless real-input browser against `driveUrl`, then expose a
 * programmatic ToolInvoker over it (no MCP/stdio). Tests inject a fake invoker into runSpecs
 * directly and never reach this path.
 *
 * Probes the port before dialing it, the same way `drive`/`verify`/`status` already do
 * (`probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus })`), because `start()` used to
 * be the FIRST thing that found out — and on any machine already running a Reticle daemon, that is
 * every machine with Reticle set up, a caller of this library function got the raw EADDRINUSE stack
 * instead of a sentence it could act on (reticlehq/reticle#1141).
 *
 * The probe can't close the window between "nothing was listening" and the bind that follows, so
 * `start()`'s own rejection is still checked for the same EADDRINUSE and given the same message. This
 * deliberately does not reach for the CLI's `process.on('uncaughtException', ...)` trick
 * (drive-command.ts): that command is a fresh, short-lived process that exits right after, while
 * `bootSession` is a library call a test runner makes repeatedly inside one long-lived process —
 * installing and tearing down a process-wide handler around every call would race concurrent specs
 * booting their own sessions in the same worker.
 */
export async function bootSession(opts: BootOptions): Promise<BootedRun> {
  const port = opts.port ?? RETICLE_DEFAULT_PORT;
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (presence !== PortPresence.FREE) {
    throw portTakenError(port, presence);
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
    if (isPortRaceLoss(error)) throw portTakenError(port, PortPresence.FOREIGN);
    throw error;
  }
  const deps = (opts.buildDeps ?? ((s) => defaultBuildDeps(s, opts)))(server);
  return { invoke: createToolInvoker(deps), close: server.close };
}

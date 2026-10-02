import { join } from 'node:path';
import { LOOPBACK_HOST, ReticleDir, ReticleEnv, RETICLE_DEFAULT_PORT } from '@reticlehq/core';
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
  /**
   * Injectable `start`, defaulting to `@reticlehq/server`'s real one. The only reason to pass this is
   * a test that needs to drive the `bridge.ready` rejection/cleanup path below deterministically — a
   * real bind-race is, by construction, not something a test can reliably force to lose without timing
   * it, which CLAUDE.md already treats as a bug in the test (reticlehq/reticle#1165 review, "Readiness
   * failure lacks test coverage").
   */
  startServer?: typeof start;
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
 * The two ways out of a taken port, named per CLAUDE.md's "no free strings" rule (reticlehq/reticle
 * #1165 review) rather than assembled inline. `STOP_DAEMON_ADVICE` is only correct when the holder is
 * a Reticle daemon `bootSession` itself could plausibly be asked to replace — for anything else,
 * `reticle stop` cannot touch the process actually holding the port, and telling the caller to run it
 * anyway leaves them still blocked with a dead lead (reticlehq/reticle#1165 review, "Stop advice
 * misidentifies holder").
 */
const DIFFERENT_PORT_ADVICE = 'Pass a different `port` to bootSession';
const STOP_DAEMON_ADVICE = 'run `reticle stop` to free this one';

/**
 * `describePresence`'s DAEMON sentence (server/src/command/daemon/binding/port-presence.ts) is a
 * deliberate mid-sentence fragment with no trailing period — other call sites append their own
 * punctuation, and some (`cli-verify.ts`) already do. Its FOREIGN sentences, by contrast, are already
 * complete. Fixing the missing period on the shared DAEMON string would double it at those other call
 * sites, so this joins onto whichever shape it gets rather than assuming one (reticlehq/reticle#1165
 * review, "Refusal uses free strings" / punctuation note).
 */
function withFullStop(fragment: string): string {
  return /[.!?]$/.test(fragment) ? fragment : `${fragment}.`;
}

/**
 * The clear refusal `bootSession` throws instead of a raw `node:net` stack (reticlehq/reticle#1141).
 * Names the port, folds in the CLI's own sentence for WHY it's unusable (`describePresence`), and
 * gives exactly the advice that applies to `presence`: a daemon can be told to stop, anything else
 * can only be waited out or dodged with a different port.
 */
function portTakenError(port: number, presence: PortPresence): Error {
  const advice =
    PortPresence.DAEMON === presence
      ? `${DIFFERENT_PORT_ADVICE}, or ${STOP_DAEMON_ADVICE}.`
      : `${DIFFERENT_PORT_ADVICE}.`;
  return new Error(
    `bootSession can't use port ${String(port)} — ${withFullStop(describePresence(presence, port))} ${advice}`,
  );
}

/** The one Node error `start()`/`bridge.ready` can still surface for a port `probePresence` just called FREE. */
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
 * The probe can't close the window between "nothing was listening" and the bind that follows, and —
 * unlike the original version of this function — that window is now actually covered. `start()`
 * itself resolves as soon as the `Bridge` object exists; the socket bind is asynchronous and only
 * `bridge.ready` observes it (server/src/index.ts's `start` never awaits it, and `Bridge`'s
 * constructor hands it back as a separate promise — server/src/portal/bridge/bridge.ts). A port lost
 * to this race therefore surfaced as an unhandled rejection on `bridge.ready`, not as a rejection of
 * `start()`, so the original `try { await start(...) } catch` here never actually saw it
 * (reticlehq/reticle#1165 review, "Bind race escapes catch"). Awaiting `bridge.ready` closes that gap.
 * If it rejects, `start()` had already gone far enough to launch the driven browser and allocate a
 * pool for it (server/src/index.ts's `resolveRealInput`), so `server.close()` runs before this
 * function throws — otherwise a lost race would leak exactly the orphaned browser process checking
 * the port before `start()` exists to prevent (reticlehq/reticle#1141's original motivation).
 *
 * This deliberately does not reach for the CLI's `process.on('uncaughtException', ...)` trick
 * (drive-command.ts): that command is a fresh, short-lived process that exits right after, while
 * `bootSession` is a library call a test runner makes repeatedly inside one long-lived process —
 * installing and tearing down a process-wide handler around every call would race concurrent specs
 * booting their own sessions in the same worker.
 *
 * The true TOCTOU race (a listener grabbing the port in the gap between the probe and the bind) still
 * has no deterministic reproduction on the real network — an artificially-timed test would be flaky by
 * construction, which CLAUDE.md's own testing rules treat as a bug in the test, not a property of the
 * machine. What IS deterministic, and now covered, is what `bootSession` does once that race is lost:
 * `BootOptions.startServer` lets a test hand back a `RunningServer` whose `bridge.ready` rejects on
 * demand, so `boot.test.ts` can assert the translation-to-refusal and the `server.close()` cleanup
 * directly, without needing to actually win a race to exercise them (reticlehq/reticle#1165 review,
 * "Readiness failure lacks test coverage"). The pre-flight refusal (a port already occupied before
 * this call begins) is the other, simpler case `boot.test.ts` covers.
 */
export async function bootSession(opts: BootOptions): Promise<BootedRun> {
  const port = opts.port ?? RETICLE_DEFAULT_PORT;
  // The same host resolution `Bridge` itself falls back to when `startOptions` below passes no
  // `host` (bridge-security.ts's `resolveBridgeSecurity`, then `Bridge`'s own constructor default) —
  // so the preflight probe checks the address the bind will actually use (reticlehq/reticle#1165
  // review, "Probe checks wrong host").
  const host = process.env[ReticleEnv.HOST] ?? LOOPBACK_HOST;
  const presence = await probePresence(port, {
    tcpOpen: (p) => probeDaemon(p, host),
    status: (p) => fetchStatus(p, host),
  });
  if (presence !== PortPresence.FREE) {
    throw portTakenError(port, presence);
  }
  const startOptions = {
    mcp: false as const,
    driveUrl: opts.driveUrl,
    headless: opts.headless ?? true,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  };
  const startServer = opts.startServer ?? start;
  let server: RunningServer;
  try {
    server = await startServer(startOptions);
  } catch (error) {
    if (isPortRaceLoss(error)) throw portTakenError(port, PortPresence.FOREIGN);
    throw error;
  }
  try {
    await server.bridge.ready;
  } catch (error) {
    await server.close();
    if (isPortRaceLoss(error)) throw portTakenError(port, PortPresence.FOREIGN);
    throw error;
  }
  const deps = (opts.buildDeps ?? ((s) => defaultBuildDeps(s, opts)))(server);
  return { invoke: createToolInvoker(deps), close: server.close };
}

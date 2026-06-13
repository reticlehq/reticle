import { join } from 'node:path';
import { IrisDir } from '@syrin/protocol';
import {
  AnnotationStore,
  BaselineStore,
  FlowStore,
  RecordingStore,
  createNodeFileSystem,
  createToolInvoker,
  start,
} from '@syrin/server';
import type { RunningServer, ToolDeps, ToolInvoker } from '@syrin/server';

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
  /** Absolute .iris root. Defaults to cwd()/.iris. Injectable for tests. */
  irisRoot?: string;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
  /** Injectable ToolDeps builder so tests can wire a fake server without real IO. */
  buildDeps?: (server: RunningServer) => ToolDeps;
}

/**
 * Build ToolDeps from a started server (Option b: zero further server changes). The only place
 * in @syrin/test that touches real IO — and it does so only by delegating to @syrin/server's start.
 */
function defaultBuildDeps(server: RunningServer, opts: BootOptions): ToolDeps {
  const fs = createNodeFileSystem();
  const irisRoot = opts.irisRoot ?? join(process.cwd(), IrisDir.ROOT);
  const now = opts.now ?? ((): number => Date.now());
  const base = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, irisRoot, { now }),
    annotations: new AnnotationStore(),
    fs,
    irisRoot,
    now,
  };
  return server.realInput !== undefined ? { ...base, realInput: server.realInput } : base;
}

/**
 * Production wiring: launch a headless real-input browser against `driveUrl`, then expose a
 * programmatic ToolInvoker over it (no MCP/stdio). Tests inject a fake invoker into runSpecs
 * directly and never reach this path.
 */
export async function bootSession(opts: BootOptions): Promise<BootedRun> {
  const startOptions = {
    mcp: false as const,
    driveUrl: opts.driveUrl,
    headless: opts.headless ?? true,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  };
  const server = await start(startOptions);
  const deps = (opts.buildDeps ?? ((s) => defaultBuildDeps(s, opts)))(server);
  return { invoke: createToolInvoker(deps), close: server.close };
}

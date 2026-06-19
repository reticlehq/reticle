import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IRIS_DEFAULT_PORT, IrisDir } from '@syrin/iris-protocol';
import { createSharedServer } from './http-server.js';
import { Bridge } from './bridge.js';
import { BaselineStore } from './project/baselines.js';
import { RecordingStore } from './flows/recordings.js';
import { FlowStore } from './flows/flows.js';
import { ProjectStore } from './project/project-store.js';
import { AnnotationStore } from './flows/annotation-store.js';
import { createNodeFileSystem } from './project/fs-port.js';
import { createMcpServer } from './mcp.js';
import { SessionReaper, endAllSessions, MCP_DISCONNECT_SUMMARY } from './session/session-reaper.js';
import { resolveToolProfile } from './tools/profiles.js';
import { CdpRealInputProvider, LaunchedRealInputProvider } from './input/real-input.js';
import type { OwnedRealInputProvider, RealInputProvider } from './input/real-input.js';
import { log } from './log.js';

export { IrisTool } from './tools/tool-names.js';
export { RingBuffer } from './events/ring-buffer.js';
export { Bridge } from './bridge.js';
export { Session, SessionManager } from './session/session.js';
export type { SessionInfo, SessionHealth } from './session/session.js';
export { buildSessionRecommendation } from './session/session-recommendation.js';
export type { RecommendationInputs } from './session/session-recommendation.js';
export { TOOLS } from './tools/tools.js';
export type { ToolDeps, ToolDef } from './tools/tools.js';
export { createToolInvoker, UNKNOWN_TOOL_ERROR } from './tools/tool-invoker.js';
export { runTool, SESSION_BOUND_TOOLS, SESSION_EXEMPT_TOOLS } from './tools/invoke-tool.js';
export type { ToolInvoker } from './tools/tool-invoker.js';
export { BaselineStore, normalizeLines, diffLines } from './project/baselines.js';
export { RecordingStore } from './flows/recordings.js';
export type { RecordedStep, CompiledProgram } from './flows/recordings.js';
export { FlowStore, recordedStepToFlowStep } from './flows/flows.js';
export type { FlowResult, Clock } from './flows/flows.js';
export {
  assertSuccess,
  successToPredicate,
  dynamicTestids,
  successLabel,
} from './flows/flow-success.js';
export { classifyFlowAssertions, FlowAssertionGrade } from './flows/flow-classify.js';
export type { FlowAssertionClassification } from './flows/flow-classify.js';
export { buildDomainModel } from './domain/domain-model.js';
export type { DomainModel, DomainFlowSummary, DomainGaps } from './domain/domain-model.js';
export { ProjectStore } from './project/project-store.js';
export type { ReadProjectResult } from './project/project-store.js';
export { VisualStore } from './visual/visual-store.js';
export { diffPng } from './visual/visual-diff.js';
export type { VisualDiffResult, VisualRect, DiffOptions } from './visual/visual-diff.js';
export { crawl } from './crawl/crawl.js';
export { MCP_SSE_PATH, MCP_MESSAGE_PATH } from './http-server.js';
export { writePid, removePid, isRunning, logPath, readPid, isAlive } from './daemon.js';
export type { CrawlReport, CrawlAnomaly, CrawlOptions, CrawlSession } from './crawl/crawl.js';
export { scrollToFind } from './input/scroll-find.js';
export type { ScrollFindResult, ScrollFindQuery, ScrollFindSession } from './input/scroll-find.js';
export {
  CORE_TOOL_NAMES,
  TOOL_PROFILE,
  TOOL_PROFILE_ENV,
  filterTools,
  resolveToolProfile,
} from './tools/profiles.js';
export type { ToolProfile } from './tools/profiles.js';
export { AnnotationStore } from './flows/annotation-store.js';
export { replayFlow, nearestTestid } from './flows/flow-replay.js';
export type { FlowReplaySession, WaitForSignal } from './flows/flow-replay.js';
export {
  ensureIrisDir,
  writeContract,
  readContract,
  irisDirPaths,
  flowPath,
  baselinePath,
} from './project/iris-dir.js';
export type { IrisDirPaths, ReadContractResult } from './project/iris-dir.js';
export { createNodeFileSystem } from './project/fs-port.js';
export type { FileSystemPort } from './project/fs-port.js';
export { evaluatePredicate, waitForPredicate, PredicateSchema } from './events/predicate.js';
export type { Predicate, EvalResult } from './events/predicate.js';
export { buildReactionReport } from './events/reaction.js';
export {
  CdpRealInputProvider,
  LaunchedRealInputProvider,
  DriveError,
  performGesture,
  boxCenter,
  isPointerAction,
} from './input/real-input.js';
export type {
  RealInputProvider,
  OwnedRealInputProvider,
  LaunchFn,
  LaunchedProviderOptions,
  ElementBox,
  RealInputArgs,
} from './input/real-input.js';

export interface StartOptions {
  port?: number;
  /** Bind address. Non-loopback hosts require a token. Defaults to IRIS_HOST or localhost. */
  host?: string;
  /** Browser/bridge pairing token. Defaults to IRIS_TOKEN. */
  token?: string;
  /** Browser origins allowed in addition to localhost. Defaults to IRIS_ALLOWED_ORIGINS. */
  allowedOrigins?: string[];
  /** When false, skip the MCP stdio transport (used in tests). */
  mcp?: boolean;
  /** CDP endpoint for native real-input mode. Defaults to env IRIS_CDP_URL. No-op if unset. */
  cdpUrl?: string;
  /** launch+own a Playwright Chromium at this url and route pointer actions through it. */
  driveUrl?: string;
  /** launch headless (default true; CLI `--headed` sets false). */
  headless?: boolean;
  /** injected so tests swap in a fake launched provider instead of real Playwright. */
  realInputFactory?: (opts: { driveUrl: string; headless: boolean }) => OwnedRealInputProvider;
  /** absolute .iris root. Defaults to process.cwd()/.iris. Injectable for tests. */
  irisRoot?: string;
  /** injectable clock for contract.json's generatedAt stamp. Defaults to Date.now. */
  now?: () => number;
  /** 'core' exposes the lean tool surface. Defaults to env IRIS_TOOL_PROFILE, else 'full'. */
  toolProfile?: string;
}

export interface RunningServer {
  bridge: Bridge;
  /** the active real-input provider (launched/CDP), if any. */
  realInput?: RealInputProvider;
  close: () => Promise<void>;
}

/** Start the Iris bridge (browser WS endpoint) and, by default, the MCP stdio server. */
export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? IRIS_DEFAULT_PORT;
  const envToken = process.env['IRIS_TOKEN'];
  const envOrigins = process.env['IRIS_ALLOWED_ORIGINS'];
  const host = options.host ?? process.env['IRIS_HOST'];
  const token =
    options.token ?? (envToken !== undefined && envToken.length > 0 ? envToken : undefined);
  const allowedOrigins =
    options.allowedOrigins ??
    envOrigins
      ?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  const bridge = new Bridge({
    port,
    ...(host === undefined ? {} : { host }),
    ...(token === undefined ? {} : { token }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  // Server-authoritative liveness: a Node-side reaper (immune to browser throttling) ends sessions
  // whose agent has gone idle, so a forgotten/crashed agent never leaves the HUD "running" forever.
  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();
  const baselines = new BaselineStore();
  const recordings = new RecordingStore();
  // drive precedence: driveUrl (launch+own a browser) → CDP (attach) → none.
  let owned: { dispose: () => Promise<void> } | undefined;
  let realInput: RealInputProvider | undefined;
  const driveUrl = options.driveUrl;
  if (driveUrl !== undefined && driveUrl.length > 0) {
    const headless = options.headless ?? true;
    const factory =
      options.realInputFactory ??
      ((opts) =>
        new LaunchedRealInputProvider({ driveUrl: opts.driveUrl, headless: opts.headless }));
    const launched = factory({ driveUrl, headless });
    try {
      await launched.navigate();
    } catch (error) {
      await bridge.close(); // no leaked WS port on a failed start
      throw error;
    }
    owned = launched;
    realInput = launched;
  } else {
    const cdpUrl = options.cdpUrl ?? process.env['IRIS_CDP_URL'];
    if (cdpUrl !== undefined && cdpUrl.length > 0) {
      const cdp = new CdpRealInputProvider({ cdpUrl });
      owned = cdp;
      realInput = cdp;
    }
  }

  if (options.mcp !== false) {
    // cwd()/Date.now() are confined to start() — never inside iris-dir.ts's pure logic (rule 7).
    const fs = createNodeFileSystem();
    const irisRoot = options.irisRoot ?? join(process.cwd(), IrisDir.ROOT);
    const now = options.now ?? ((): number => Date.now());
    const flows = new FlowStore(fs, irisRoot, { now });
    const project = new ProjectStore(fs, irisRoot, { now });
    const annotations = new AnnotationStore();
    const deps = {
      sessions: bridge.sessions,
      baselines,
      recordings,
      annotations,
      flows,
      project,
      fs,
      irisRoot,
      now,
    };
    const profile = resolveToolProfile(options.toolProfile);
    const server = createMcpServer(
      realInput !== undefined ? { ...deps, realInput } : deps,
      profile,
    );
    // When Claude (the MCP client) disconnects cleanly, end every active session at once so the HUD
    // doesn't linger. (If Claude instead KILLS this process, the WS dies and the browser self-ends
    // via SESSION_LIFECYCLE.BRIDGE_LOST_MS — see transport.ts.)
    server.server.onclose = () => {
      endAllSessions(bridge.sessions, MCP_DISCONNECT_SUMMARY);
    };
    await server.connect(new StdioServerTransport());
    log('mcp_connected', { port });
  }

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    close: async () => {
      reaper.stop();
      await owned?.dispose();
      await bridge.close();
    },
  };
}

/**
 * Start the Iris bridge in daemon mode: a single HTTP server handles both the WebSocket
 * bridge (browser SDK) and the SSE MCP transport (Claude/agent). Unlike start(), the MCP
 * connection is not tied to the process lifetime — Claude reconnects across sessions while
 * browser sessions persist in the daemon.
 */
export async function startDaemon(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? IRIS_DEFAULT_PORT;

  const shared = createSharedServer();
  const bridge = new Bridge({ port, server: shared.httpServer });
  // `iris status` GETs this for a live, at-a-glance view of connected tabs + their health.
  shared.attachStatus(() => ({
    running: true,
    sessionCount: bridge.sessions.count(),
    sessions: bridge.sessions.list(),
  }));

  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();

  let owned: { dispose: () => Promise<void> } | undefined;
  let realInput: RealInputProvider | undefined;
  const driveUrl = options.driveUrl;
  if (driveUrl !== undefined && driveUrl.length > 0) {
    const headless = options.headless ?? true;
    const factory =
      options.realInputFactory ??
      ((opts) =>
        new LaunchedRealInputProvider({ driveUrl: opts.driveUrl, headless: opts.headless }));
    const launched = factory({ driveUrl, headless });
    try {
      await launched.navigate();
    } catch (error) {
      await shared.close();
      throw error;
    }
    owned = launched;
    realInput = launched;
  } else {
    const cdpUrl = options.cdpUrl ?? process.env['IRIS_CDP_URL'];
    if (cdpUrl !== undefined && cdpUrl.length > 0) {
      const cdp = new CdpRealInputProvider({ cdpUrl });
      owned = cdp;
      realInput = cdp;
    }
  }

  const fs = createNodeFileSystem();
  const irisRoot = options.irisRoot ?? join(process.cwd(), IrisDir.ROOT);
  const now = options.now ?? ((): number => Date.now());
  const flows = new FlowStore(fs, irisRoot, { now });
  const project = new ProjectStore(fs, irisRoot, { now });
  const annotations = new AnnotationStore();
  const deps = {
    sessions: bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    annotations,
    flows,
    project,
    fs,
    irisRoot,
    now,
  };
  const profile = resolveToolProfile(options.toolProfile);
  const effectiveDeps = realInput !== undefined ? { ...deps, realInput } : deps;
  shared.attachMcp(() => createMcpServer(effectiveDeps, profile));

  await new Promise<void>((resolve) => {
    shared.httpServer.once('listening', resolve);
    shared.httpServer.listen(port, '127.0.0.1');
  });

  log('mcp_daemon_started', { port });

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    close: async () => {
      reaper.stop();
      await owned?.dispose();
      await bridge.close();
      await shared.close();
    },
  };
}

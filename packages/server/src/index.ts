import { join } from 'node:path';
import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_STOPPED_NOTICE,
  IRIS_DEFAULT_PORT,
  IrisCommand,
  IrisDir,
  IrisEnv,
  LOOPBACK_HOST,
  ReplayStatus,
} from '@syrin/iris-protocol';
import type { FlowReplayResult } from '@syrin/iris-protocol';
import { replayNamedFlow } from './flows/flow-tools.js';
import { createSharedServer } from './http-server.js';
import { Bridge } from './bridge.js';
import { BaselineStore } from './project/baselines.js';
import { RecordingStore } from './flows/recordings.js';
import { FlowStore } from './flows/flows.js';
import { ProjectStore } from './project/project-store.js';
import { AnnotationStore } from './flows/annotation-store.js';
import { createNodeFileSystem } from './project/fs-port.js';
import { IrisRunner } from './runs/iris-runner.js';
import { createRunnerPort } from './runs/runner-port.js';
import { RunStore } from './runs/run-store.js';
import { startVerifyServer } from './runs/verify-server.js';
import { createMcpServer } from './mcp.js';
import { SessionReaper, endAllSessions, MCP_DISCONNECT_SUMMARY } from './session/session-reaper.js';
import { resolveToolProfile } from './tools/profiles.js';
import { CdpRealInputProvider, LaunchedRealInputProvider } from './input/real-input.js';
import type {
  OwnedRealInputProvider,
  RealInputProvider,
  InjectConnectOptions,
} from './input/real-input.js';
import { log } from './log.js';

/** A human-facing one-liner for a panel replay verdict — ✓ passed / ⚠ drifted / ✗ errored. */
function replayVerdictLine(result: FlowReplayResult): string {
  if (result.status === ReplayStatus.OK) return `✓ "${result.name}" passed`;
  if (result.status === ReplayStatus.DRIFT)
    return `⚠ "${result.name}" drifted — a step no longer matches`;
  return `✗ "${result.name}" failed — ${result.error?.message ?? 'could not replay'}`;
}

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
// Replay/Verify API — the programmatic surface an OEM/CI pipeline drives (see docs/integration.md).
export { IrisRunner } from './runs/iris-runner.js';
export type { RunnerPort, VerifyOptions } from './runs/iris-runner.js';
export { createRunnerPort, defaultRunId } from './runs/runner-port.js';
export { buildVerificationRun, computeVerdict } from './runs/build-verification-run.js';
export type { VerificationRunInput } from './runs/build-verification-run.js';
export { RunStore } from './runs/run-store.js';
export type { ReadRunResult } from './runs/run-store.js';
export { classifyChangedFiles, buildRisks, risksForPath } from './runs/risk-classify.js';
export type { ChangedFileInput, RiskPolicy } from './runs/risk-classify.js';
export { buildRepairPacket, buildRepairPackets } from './runs/repair-prompt.js';
export { redactForProfile, REDACTED } from './runs/profile-redact.js';
export { renderRunReport } from './runs/render-report.js';
export { handleVerifyRequest, tokenOk, VERIFY_PATH } from './runs/verify-http.js';
export type { VerifyHttpRequest, VerifyHttpResponse } from './runs/verify-http.js';
export {
  createVerifyRequestListener,
  startVerifyServer,
  TOKEN_HEADER,
} from './runs/verify-server.js';
export type { VerifyServerOptions } from './runs/verify-server.js';
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
  /** When driving, force the page's SDK to (re)connect to our bridge with this token — verify a hosted preview. */
  injectConnect?: InjectConnectOptions;
  /** Path to a Playwright storageState JSON so the driven browser starts authenticated (past a login wall). */
  storageState?: string;
  /** absolute .iris root. Defaults to process.cwd()/.iris. Injectable for tests. */
  irisRoot?: string;
  /** injectable clock for contract.json's generatedAt stamp. Defaults to Date.now. */
  now?: () => number;
  /** 'core' exposes the lean tool surface. Defaults to env IRIS_TOOL_PROFILE, else 'full'. */
  toolProfile?: string;
  /** Start the OEM/CI verify HTTP endpoint alongside the daemon (`iris serve --http`). */
  httpVerify?: boolean;
  /** Port for the verify endpoint. Defaults to IRIS_VERIFY_DEFAULT_PORT. */
  httpVerifyPort?: number;
  /** Shared token for the verify endpoint. Defaults to env IRIS_VERIFY_TOKEN, else open (localhost). */
  httpVerifyToken?: string;
}

/** Default localhost port for the verify HTTP endpoint (see docs/integration.md). */
export const IRIS_VERIFY_DEFAULT_PORT = 7331;

export interface RunningServer {
  bridge: Bridge;
  /** the active real-input provider (launched/CDP), if any. */
  realInput?: RealInputProvider;
  /** the bound port of the verify HTTP endpoint, when `httpVerify` is enabled. */
  verifyPort?: number;
  close: () => Promise<void>;
}

/**
 * Resolve the bridge's security options from explicit options first, then the environment. Shared by
 * both `start()` and `startDaemon()` so the token/host/origin contract is enforced identically on
 * every entrypoint — a past divergence let daemon mode silently run with auth disabled.
 */
export function resolveBridgeSecurity(options: StartOptions): {
  host?: string;
  token?: string;
  allowedOrigins?: string[];
} {
  const envToken = process.env[IrisEnv.TOKEN];
  const envOrigins = process.env[IrisEnv.ALLOWED_ORIGINS];
  const host = options.host ?? process.env[IrisEnv.HOST];
  const token =
    options.token ?? (envToken !== undefined && envToken.length > 0 ? envToken : undefined);
  const allowedOrigins =
    options.allowedOrigins ??
    envOrigins
      ?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  return {
    ...(host === undefined ? {} : { host }),
    ...(token === undefined ? {} : { token }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  };
}

/** Start the Iris bridge (browser WS endpoint) and, by default, the MCP stdio server. */
export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? IRIS_DEFAULT_PORT;
  const bridge = new Bridge({ port, ...resolveBridgeSecurity(options) });
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
    const injectConnect = options.injectConnect;
    const storageState = options.storageState;
    const factory =
      options.realInputFactory ??
      ((opts) =>
        new LaunchedRealInputProvider({
          driveUrl: opts.driveUrl,
          headless: opts.headless,
          ...(injectConnect !== undefined ? { injectConnect } : {}),
          ...(storageState !== undefined ? { storageState } : {}),
        }));
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
    const cdpUrl = options.cdpUrl ?? process.env[IrisEnv.CDP_URL];
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
    // When the agent (the MCP client) disconnects cleanly, end every active session at once so the
    // HUD doesn't linger. (If the agent instead KILLS this process, the WS dies and the browser
    // self-ends via SESSION_LIFECYCLE.BRIDGE_LOST_MS — see transport.ts.)
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

  const security = resolveBridgeSecurity(options);
  const shared = createSharedServer();
  const bridge = new Bridge({ port, server: shared.httpServer, ...security });
  // The daemon owns listen() (below), so the real bind error is reported there; absorb bridge.ready's
  // mirror rejection so a port collision can't surface as an unhandled promise rejection.
  void bridge.ready.catch(() => undefined);
  // `iris status` GETs this for a live, at-a-glance view of connected tabs + their health.
  shared.attachStatus(() => ({
    running: true,
    sessionCount: bridge.sessions.count(),
    sessions: bridge.sessions.list(),
  }));
  // Agent-independent presence: the daemon outlives any single agent, so when the LAST agent's MCP
  // connection drops (it stopped, or is waiting on the human), end every session and push a clear
  // "go to your terminal" notice to the panel — the human is on the browser and must not lose a typed
  // prompt into a dead session. A returning agent's next tool call revives the auto-ended session.
  shared.attachAgentPresence((connected) => {
    if (!connected) endAllSessions(bridge.sessions, AGENT_STOPPED_NOTICE);
  });

  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();

  let owned: { dispose: () => Promise<void> } | undefined;
  let realInput: RealInputProvider | undefined;
  const driveUrl = options.driveUrl;
  if (driveUrl !== undefined && driveUrl.length > 0) {
    const headless = options.headless ?? true;
    const injectConnect = options.injectConnect;
    const storageState = options.storageState;
    const factory =
      options.realInputFactory ??
      ((opts) =>
        new LaunchedRealInputProvider({
          driveUrl: opts.driveUrl,
          headless: opts.headless,
          ...(injectConnect !== undefined ? { injectConnect } : {}),
          ...(storageState !== undefined ? { storageState } : {}),
        }));
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
    const cdpUrl = options.cdpUrl ?? process.env[IrisEnv.CDP_URL];
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

  // Optional OEM/CI verify endpoint: a host platform POSTs to /verify and gets an IrisVerificationRun,
  // driving the same flow-replay machinery the agent uses — no MCP stdio, no human. Each verdict is
  // persisted via RunStore. Localhost-bound + token-guarded. Off unless `iris serve --http`.
  let verifyHttp: { server: Server; port: number } | undefined;
  if (options.httpVerify === true) {
    const runStore = new RunStore(fs, irisRoot);
    const runner = new IrisRunner(createRunnerPort(effectiveDeps));
    const token = options.httpVerifyToken ?? process.env[IrisEnv.VERIFY_TOKEN] ?? '';
    verifyHttp = await startVerifyServer(
      { runner, token, persist: (run) => runStore.write(run) },
      options.httpVerifyPort ?? IRIS_VERIFY_DEFAULT_PORT,
    );
    log('iris_verify_http_started', { port: verifyHttp.port, tokenRequired: token.length > 0 });
  }

  // Replay-from-panel: the human clicks ▶ on a saved flow; run it with NO agent and narrate the
  // verdict into the same activity log they watch the agent in. The page animates via the normal
  // replay path, so they see it re-drive and the ✓/⚠/✗ land.
  bridge.attachReplay((sessionId, flowName) => {
    const session = bridge.sessions.get(sessionId);
    if (session === undefined) return;
    session.pushNarration(`▶ Replaying "${flowName}"…`);
    replayNamedFlow(effectiveDeps, { flowName, sessionId })
      .then((result) => session.pushNarration(replayVerdictLine(result)))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        session.pushNarration(`✗ Replay "${flowName}" failed — ${message}`);
      });
  });
  // On connect, hand the panel the replayable-flow names so it can render the ▶ list.
  bridge.attachSessionReady((session) => {
    flows
      .list()
      .then((names) =>
        session.command(IrisCommand.FLOWS, { flows: names.map((name) => ({ name })) }),
      )
      .catch(() => undefined);
  });

  // Bind with BOTH a 'listening' and an 'error' handler. Without the error path, a port collision
  // (EADDRINUSE — another daemon already owns this port) emits 'error' with no listener, so the
  // promise never settles and the daemon hangs forever, orphaning the process and its PID file.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      shared.httpServer.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      shared.httpServer.removeListener('error', onError);
      resolve();
    };
    shared.httpServer.once('error', onError);
    shared.httpServer.once('listening', onListening);
    shared.httpServer.listen(port, security.host ?? LOOPBACK_HOST);
  });

  log('mcp_daemon_started', { port });

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    ...(verifyHttp !== undefined ? { verifyPort: verifyHttp.port } : {}),
    close: async () => {
      reaper.stop();
      const vh = verifyHttp;
      if (vh !== undefined) await new Promise<void>((resolve) => vh.server.close(() => resolve()));
      await owned?.dispose();
      await bridge.close();
      await shared.close();
    },
  };
}

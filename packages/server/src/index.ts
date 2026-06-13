import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IRIS_DEFAULT_PORT, IrisDir } from '@syrin/iris-protocol';
import { Bridge } from './bridge.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from './project-store.js';
import { AnnotationStore } from './annotation-store.js';
import { createNodeFileSystem } from './fs-port.js';
import { createMcpServer } from './mcp.js';
import { resolveToolProfile } from './profiles.js';
import { CdpRealInputProvider, LaunchedRealInputProvider } from './real-input.js';
import type { OwnedRealInputProvider, RealInputProvider } from './real-input.js';
import { log } from './log.js';

export { IrisTool } from './tool-names.js';
export { RingBuffer } from './ring-buffer.js';
export { Bridge } from './bridge.js';
export { Session, SessionManager } from './session.js';
export type { SessionInfo, SessionHealth } from './session.js';
export { buildSessionRecommendation } from './session-recommendation.js';
export type { RecommendationInputs } from './session-recommendation.js';
export { TOOLS } from './tools.js';
export type { ToolDeps, ToolDef } from './tools.js';
export { createToolInvoker, UNKNOWN_TOOL_ERROR } from './tool-invoker.js';
export { runTool, SESSION_BOUND_TOOLS, SESSION_EXEMPT_TOOLS } from './invoke-tool.js';
export type { ToolInvoker } from './tool-invoker.js';
export { BaselineStore, normalizeLines, diffLines } from './baselines.js';
export { RecordingStore } from './recordings.js';
export type { RecordedStep, CompiledProgram } from './recordings.js';
export { FlowStore, recordedStepToFlowStep } from './flows.js';
export type { FlowResult, Clock } from './flows.js';
export { ProjectStore } from './project-store.js';
export type { ReadProjectResult } from './project-store.js';
export { VisualStore } from './visual-store.js';
export { diffPng } from './visual-diff.js';
export type { VisualDiffResult, VisualRect, DiffOptions } from './visual-diff.js';
export { crawl } from './crawl.js';
export type { CrawlReport, CrawlAnomaly, CrawlOptions, CrawlSession } from './crawl.js';
export { scrollToFind } from './scroll-find.js';
export type { ScrollFindResult, ScrollFindQuery, ScrollFindSession } from './scroll-find.js';
export {
  CORE_TOOL_NAMES,
  TOOL_PROFILE,
  TOOL_PROFILE_ENV,
  filterTools,
  resolveToolProfile,
} from './profiles.js';
export type { ToolProfile } from './profiles.js';
export { AnnotationStore } from './annotation-store.js';
export { replayFlow, nearestTestid } from './flow-replay.js';
export type { FlowReplaySession, WaitForSignal } from './flow-replay.js';
export {
  ensureIrisDir,
  writeContract,
  readContract,
  irisDirPaths,
  flowPath,
  baselinePath,
} from './iris-dir.js';
export type { IrisDirPaths, ReadContractResult } from './iris-dir.js';
export { createNodeFileSystem } from './fs-port.js';
export type { FileSystemPort } from './fs-port.js';
export { evaluatePredicate, waitForPredicate, PredicateSchema } from './predicate.js';
export type { Predicate, EvalResult } from './predicate.js';
export { buildReactionReport } from './reaction.js';
export {
  CdpRealInputProvider,
  LaunchedRealInputProvider,
  DriveError,
  performGesture,
  boxCenter,
  isPointerAction,
} from './real-input.js';
export type {
  RealInputProvider,
  OwnedRealInputProvider,
  LaunchFn,
  LaunchedProviderOptions,
  ElementBox,
  RealInputArgs,
} from './real-input.js';

export interface StartOptions {
  port?: number;
  /** When false, skip the MCP stdio transport (used in tests). */
  mcp?: boolean;
  /** R1: CDP endpoint for native real-input mode. Defaults to env IRIS_CDP_URL. No-op if unset. */
  cdpUrl?: string;
  /** P2-drive: launch+own a Playwright Chromium at this url and route pointer actions through it. */
  driveUrl?: string;
  /** P2-drive: launch headless (default true; CLI `--headed` sets false). */
  headless?: boolean;
  /** P2-drive: injected so tests swap in a fake launched provider instead of real Playwright. */
  realInputFactory?: (opts: { driveUrl: string; headless: boolean }) => OwnedRealInputProvider;
  /** M8 Stage A: absolute .iris root. Defaults to process.cwd()/.iris. Injectable for tests. */
  irisRoot?: string;
  /** M8 Stage A: injectable clock for contract.json's generatedAt stamp. Defaults to Date.now. */
  now?: () => number;
  /** 0.3.7 FLUENCY: 'core' exposes the lean tool surface. Defaults to env IRIS_TOOL_PROFILE, else 'full'. */
  toolProfile?: string;
}

export interface RunningServer {
  bridge: Bridge;
  /** P2-drive: the active real-input provider (launched/CDP), if any. */
  realInput?: RealInputProvider;
  close: () => Promise<void>;
}

/** Start the Iris bridge (browser WS endpoint) and, by default, the MCP stdio server. */
export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? IRIS_DEFAULT_PORT;
  const bridge = new Bridge({ port });
  const baselines = new BaselineStore();
  const recordings = new RecordingStore();
  // P2-drive precedence: driveUrl (launch+own a browser) → CDP (attach) → none.
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
    await server.connect(new StdioServerTransport());
    log('mcp_connected', { port });
  }

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    close: async () => {
      await owned?.dispose();
      await bridge.close();
    },
  };
}

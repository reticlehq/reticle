import { applyHarnessSwitch, harnessConfigsByRoot } from '@/memory/cloud/harness-config.js';
import { coveragePercents } from './features/exhaust/ledger.js';
import { agentWiring } from './portal/session/zero-install-first-call.js';
import { pushIfMoved, watchAccountFiles } from './memory/impact/account-watch.js';
import { SESSION_FILE } from './command/cli/cloud-kit.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { linkedCloudPort, sessionCloudPort } from './memory/cloud/cloud-config.js';
import { sessionRoot } from './memory/project/session-root.js';
import { attachCloudSync, flushWithin } from './memory/cloud/sync-daemon.js';
import { wireHooks } from './hooks/hook-commands.js';
import { currentDrivenBy } from './hooks/driven-by.js';
import { artifactRootResolver } from './memory/project/artifact-root-resolver.js';
import { servingDirectoryOf } from './portal/session/serving-directory.js';
import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_STOPPED_NOTICE,
  RETICLE_DEFAULT_PORT,
  ReticleCommand,
  ReticleDir,
  ReticleEnv,
  LOOPBACK_HOST,
} from '@reticlehq/core';
import { replayFromHud } from './language/flows/replay-from-hud.js';
import { createSharedServer } from './surface/http-server.js';
import { openLoopbackAlias } from './command/daemon/binding/loopback-alias.js';
import { reportAppInstrumented } from './telemetry/app-instrumented.js';
import { resolveBridgeSecurityWithAutoToken } from './portal/bridge/bridge-security.js';
import type { StartOptions } from './start-options.js';
export type { StartOptions } from './start-options.js';
import { Bridge } from './portal/bridge/bridge.js';
import { connectionSkew } from './command/version/version-nudge.js';
import { SERVER_VERSION } from './command/version/identity/server-version.js';
import { BaselineStore } from './memory/project/baselines.js';
import { RecordingStore } from './language/flows/recording/tape/recordings.js';
import { initImpact, impactSnapshot } from './memory/impact/impact-recorder.js';
import { flowAuthor } from './language/flows/flow-author.js';
import { FlowStore } from './language/flows/flows.js';
import { buildFlowChips } from './language/flows/flow-scope.js';
import { ProjectStore } from './memory/project/project-store.js';
import { projectStoreResolver } from './memory/project/project-for-root.js';
import { attachRouteLearning } from './memory/project/learned-routes.js';
import { AnnotationStore } from './language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from './memory/project/fs/fs-port.js';
import { cleanupCaptureDirectories } from './features/visual/capture-cleanup.js';
import { ReticleRunner } from './judgement/runs/reticle-runner.js';
import { createRunnerPort } from './judgement/runs/runner-port.js';
import { RunStore } from './judgement/runs/artifact/run-store.js';
import { startVerifyServer } from './judgement/runs/verify-server.js';
import { createMcpServer } from './surface/mcp/mcp.js';
import { instructionStateAt } from './surface/mcp/mcp-proxy.js';
import { LEASE_ACQUIRE_TOOL } from './surface/tools/lease-tools.js';
import { attachHudHarness, projectLinkOnly, startChatDrives } from './surface/tools/chat-drives.js';
import { runTool } from './surface/tools/invoke-tool.js';
import {
  SessionReaper,
  endAllSessions,
  MCP_DISCONNECT_SUMMARY,
} from './portal/session/session-reaper.js';
import { wireSessionScope } from './portal/session/no-session-watch.js';
import { buildIdlePredicate, noteSetupHold } from './command/daemon/lifetime/daemon-usefulness.js';
import { resolveToolSurface } from './surface/tools/tool-surface.js';
import { statusPayload } from './status-payload.js';
import type { BrowserPool } from './portal/pool/browser-pool.js';
import {
  AGENT_ALREADY_DRIVING_ELSEWHERE,
  shouldGreetWithLeaseNotice,
} from './portal/session/lease-visibility.js';
import { LeaseReaper } from './portal/pool/lease-reaper.js';
import {
  findProjectConfig,
  readJournalEnabled,
  readProjectId,
} from './command/cli/ports/resolve/cli-port.js';
import { probeLaunchableChromium } from './launch-chromium.js';
import { attachJournal } from './wire-journal.js';
import { reportOnboardingStep } from './telemetry/onboarding-funnel.js';
import { readRetainPolicy } from './memory/journal/on-disk/retain-policy.js';
import type { RealInputProvider } from './portal/input/real-input.js';
import { log } from './log.js';
import {
  createBrowserPool,
  knownProjectRoots,
  loadHarnessConfig,
  makeNetworkDetailRouter,
  platformEnvFor,
  readerConnect,
  resolveRealInput,
  sdkFixForProject,
} from './start-wiring.js';

export { replayVerdictLine } from './language/flows/replay-from-hud.js';

// Re-exported from the contract, where the names now live: a consumer importing the server should
// not have to know that the vocabulary moved.
export { ReticleTool } from '@reticlehq/core';
export { RingBuffer } from '@reticlehq/engine/window/ring-buffer.js';
export { Bridge } from './portal/bridge/bridge.js';
export { Session } from './portal/session/session.js';
export { SessionManager } from './portal/session/session-manager.js';
export type { SessionInfo, SessionHealth } from './portal/session/session.js';
export { buildSessionRecommendation } from './portal/session/presence/session-recommendation.js';
export type { RecommendationInputs } from './portal/session/presence/session-recommendation.js';
export { TOOLS } from './surface/tools/tools.js';
export type { ToolDeps, ToolDef } from './surface/tools/tools.js';
export { createToolInvoker, UNKNOWN_TOOL_ERROR } from './surface/tools/tool-invoker.js';
export { runTool, SESSION_BOUND_TOOLS, SESSION_EXEMPT_TOOLS } from './surface/tools/invoke-tool.js';
export type { ToolInvoker } from './surface/tools/tool-invoker.js';

/**
 * The port-presence check the CLI commands (`drive`, `verify`, `status`, `doctor`, `kill`) all share,
 * re-exported so a consumer embedding `start()` in its own process can refuse a taken port the same
 * honest way instead of letting a raw `EADDRINUSE` stack out — the gap `@reticlehq/test`'s
 * `bootSession()` had (reticlehq/reticle#1141): it called `start()` directly with no pre-flight probe.
 */
export {
  probePresence,
  describePresence,
  PortPresence,
} from './command/daemon/binding/port-presence.js';
export { probeDaemon } from './surface/mcp/proxy/proxy-daemon-probe.js';
export { fetchStatus } from './command/daemon/binding/daemon-status-probe.js';
export { BaselineStore, normalizeLines, diffLines } from './memory/project/baselines.js';
export { RecordingStore } from './language/flows/recording/tape/recordings.js';
export type { RecordedStep, CompiledProgram } from './language/flows/recording/tape/recordings.js';
export { FlowStore, recordedStepToFlowStep } from './language/flows/flows.js';
export type { FlowResult } from './language/flows/flows.js';
export type { Clock } from './machine/clock.js';
export {
  assertSuccess,
  dynamicTestids,
  successLabel,
  successToPredicate,
} from './language/flows/flow-success.js';
export { classifyFlowAssertions, FlowAssertionGrade } from './language/flows/flow-classify.js';
export type { FlowAssertionClassification } from './language/flows/flow-classify.js';
export { buildDomainModel } from './judgement/domain/domain-model.js';
export type {
  DomainModel,
  DomainFlowSummary,
  DomainGaps,
} from './judgement/domain/domain-model.js';
export { ProjectStore } from './memory/project/project-store.js';
export type { ReadProjectResult } from './memory/project/project-store.js';
export { VisualStore } from './features/visual/visual-store.js';
export { diffPng } from './features/visual/visual-diff.js';
export type { VisualDiffResult, VisualRect, DiffOptions } from './features/visual/visual-diff.js';
export { crawl } from './features/crawl/crawl.js';
/**
 * The contradiction pass, and the seam a consumer adds its own rules through.
 *
 * Exported because a service embedding this engine grades a recording the same way the tools do, and
 * without these it would have to re-implement the fold — a second implementation of the one thing
 * this product is judged on, and the one nobody dogfoods is the one that rots.
 */
export { findContradictions } from '@reticlehq/engine/disagreement/contradictions.js';

/** Default localhost port for the verify HTTP endpoint (see docs/platform-integration.md). */
export const RETICLE_VERIFY_DEFAULT_PORT = 7331;

export interface RunningServer {
  bridge: Bridge;
  /** the active real-input provider (launched/CDP), if any. */
  realInput?: RealInputProvider;
  /** the bound port of the verify HTTP endpoint, when `httpVerify` is enabled. */
  verifyPort?: number;
  /** True when nothing is using the daemon: no agent connected, no browser session, no pool lease.
   * The daemon entry (cli.ts) polls this to self-shut-down when idle so Reticle never lingers. */
  isIdle?: () => boolean;
  /** True while an agent's MCP client is attached — see IdleShutdownOptions.agentAttached. */
  agentAttached?: () => boolean;
  /** The pairing token the bridge is enforcing (explicit, env, or auto-provisioned); undefined if none. */
  token?: string;
  /**
   * Tell every attached MCP proxy this daemon is retiring, before anything closes.
   *
   * Optional because only the daemon entry point serves MCP over SSE — `start()` speaks stdio, where
   * the client owns the process and there is no stream to warn. See SharedServer.announceShutdown.
   */
  announceShutdown?: () => void;
  close: () => Promise<void>;
}

export { resolveBridgeSecurity } from './portal/bridge/bridge-security.js';

/** How long `start().close()` waits for its last sync cycle. Exit must not hang on the network. */
const EXIT_SYNC_BUDGET_MS = 5_000;

/** Start the Reticle bridge (browser WS endpoint) and, by default, the MCP stdio server. */
export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  const configForRoot = harnessConfigsByRoot(loadHarnessConfig);
  // Open the user's impact record before anything can connect. Not inside the MCP branch: a daemon
  // serving a browser with no agent attached still has a HUD to answer, and a report that reads
  // "nothing recorded yet" over a month of history on disk is the worst version of this feature.
  initImpact({
    sdkVersion: SERVER_VERSION,
    reticleRoot: options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT),
    // The daemon owns both sides of this seam, so it is the layer that may join them: the cache
    // lives in cloud memory, the platform read lives in the harness feature, and neither is allowed
    // to reach for the other.
    configForRoot,
    coverageForRoot: (root: string) => () => coveragePercents(root),
  });
  const uninstallHooks = wireHooks(
    options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT),
    readProjectId(process.cwd()),
  );
  /*
   * The same sync the daemon runs. `reticle drive` without a daemon and a self-booting `verify` run
   * here, and their work waited on disk for a later daemon. It does nothing for an unlinked root,
   * and `close` sends one last bounded cycle.
   */
  const cloudSync = attachCloudSync({
    fs: createNodeFileSystem(),
    reticleRoot: options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT),
    homeDir: homedir(),
    env: process.env,
    otherRoots: knownProjectRoots,
  });
  const security = await resolveBridgeSecurityWithAutoToken(options);
  const bridge = new Bridge({ port, sdkFix: sdkFixForProject, ...security });
  // Server-authoritative liveness: a Node-side reaper (immune to browser throttling) ends sessions
  // whose agent has gone idle, so a forgotten/crashed agent never leaves the HUD "running" forever.
  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();
  // Scope auto-selection to the active project (from .reticle.json) so a stray tab from another app is
  // never picked when the agent omits a sessionId. Explicit per-call scope/sessionId still overrides.
  const activeProjectId = readProjectId(process.cwd());
  if (activeProjectId !== undefined) {
    bridge.sessions.setDefaultScope({ projectId: activeProjectId });
  }
  const baselines = new BaselineStore();
  const recordings = new RecordingStore(() => currentDrivenBy() !== undefined);
  // drive precedence: driveUrl (launch+own a browser) → CDP (attach) → none.
  let pool: BrowserPool | undefined;
  let leaseReaper: LeaseReaper | undefined;
  // Route CDP-authoritative network detail (drive path only) onto the driven session's journal: the
  // page and the SDK session share an origin, so a NET_DETAIL is pushed to the matching connected session.
  const routeNetworkDetail = makeNetworkDetailRouter(bridge, options.driveUrl);
  const { realInput, owned } = await resolveRealInput(
    options,
    () => bridge.close(),
    routeNetworkDetail,
  );

  let chatDrives: { stop: () => void } | undefined;
  if (options.mcp !== false) {
    // cwd/Date.now are confined to start — never inside reticle-dir.ts's pure logic (rule 7).
    const fs = createNodeFileSystem();
    const reticleRoot = options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT);
    const now = options.now ?? ((): number => Date.now());
    const retain = readRetainPolicy(findProjectConfig(process.cwd()));
    // `retain.sessions: 0` says keep no journals. Honoured at CAPTURE as well as at the sweep —
    // writing a directory in order to delete it on the way out is work nobody asked for.
    const journalEnabled =
      readJournalEnabled(process.cwd(), process.env[ReticleEnv.JOURNAL]) && 0 < retain.sessions;
    const flows = new FlowStore(fs, reticleRoot, { now });
    attachJournal(bridge, {
      fs,
      reticleRoot,
      enabled: journalEnabled,
      retain,
      // Bound HERE, where the recorder is already in hand: teardown gets the tape, not the recorder.
      takeAmbientTape: (sessionId) => recordings.takeAmbient(sessionId),
      reportStep: reportOnboardingStep,
      flows,
      author: flowAuthor,
      // A run or flow written mid-drive goes out within seconds, as it does under the daemon.
      onRunPersisted: () => cloudSync.nudge(),
    });
    const project = new ProjectStore(fs, reticleRoot, { now });
    attachRouteLearning(bridge, projectStoreResolver(fs, project, reticleRoot, now));
    const annotations = new AnnotationStore();
    pool = createBrowserPool(options.headless ?? true, readerConnect(port, security.token));
    leaseReaper = new LeaseReaper(pool);
    leaseReaper.start();
    /*
     * Tell a tab that ARRIVES during a lease why its HUD is silent.
     *
     * The acquire-time notice only reaches tabs already connected, so opening the app — or merely
     * reloading it — while an agent held a lease landed somebody on a dark HUD with nothing
     * explaining it. That is the more common way to hit it, because a person opens the dashboard
     * precisely when they want to watch. Reported as "dashboard is being watched, but the agent chat
     * shows nothing".
     *
     * Registered separately from the journal hook rather than folded into it: this one needs the
     * pool, which does not exist on the no-drive path, and session-create handlers are additive.
     */
    const leasePool = pool;
    bridge.attachSessionCreate((session) => {
      const leasedIds = leasePool.leasedSessionIds();
      const leasedProjects = leasedIds.map((id) => bridge.sessions.get(id)?.projectId);
      if (shouldGreetWithLeaseNotice(session, leasedIds, leasedProjects))
        session.pushNarration(AGENT_ALREADY_DRIVING_ELSEWHERE);
    });
    const deps = {
      sessions: bridge.sessions,
      pool,
      baselines,
      recordings,
      annotations,
      flows,
      project,
      fs,
      reticleRoot,
      linkedCloud: linkedCloudPort(fs, reticleRoot, homedir(), process.env),
      artifactRootFor: artifactRootResolver(reticleRoot, { servingDirectory: servingDirectoryOf }),
      now,
      bridgePort: port,
      browserProbe: probeLaunchableChromium,
      // The daemon's OWN project, so a tool can tell "this session is mine" from "this session
      // belongs to a sibling app under the same daemon". contract_save refuses on the second.
      ...(activeProjectId === undefined ? {} : { projectId: activeProjectId }),
    };
    const profile = resolveToolSurface(options.toolProfile);
    const toolDeps = realInput !== undefined ? { ...deps, realInput } : deps;
    // The platform chat sees this app too: `reticle drive` in a window runs here, not in a daemon.
    chatDrives = startChatDrives(
      toolDeps,
      bridge.sessions,
      fs,
      {
        sessionCloud: sessionCloudPort(fs, homedir(), process.env, (id) =>
          sessionRoot(toolDeps, id),
        ),
        version: SERVER_VERSION,
      },
      log,
    );
    const server = createMcpServer(
      toolDeps,
      profile,
      instructionStateAt(port, bridge.sessions.count()),
    );
    // When the agent (the MCP client) disconnects cleanly, end every active session at once so the
    // HUD doesn't linger. (If the agent instead KILLS this process, the WS dies and the browser
    // self-ends via SESSION_LIFECYCLE.BRIDGE_LOST_MS — see transport.ts.)
    server.server.onclose = () => {
      endAllSessions(bridge.sessions, MCP_DISCONNECT_SUMMARY);
      // The client often kills this process without calling `close`: send what the teardown wrote.
      cloudSync.nudge();
    };
    await server.connect(new StdioServerTransport());
    log('mcp_connected', { port });
  }

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    ...(security.token !== undefined ? { token: security.token } : {}),
    close: async () => {
      reaper.stop();
      uninstallHooks();
      await cleanupCaptureDirectories();
      leaseReaper?.stop();
      chatDrives?.stop();
      await flushWithin(cloudSync, EXIT_SYNC_BUDGET_MS);
      await pool?.shutdown();
      await owned?.dispose();
      await bridge.close();
    },
  };
}

/**
 * Start the Reticle bridge in daemon mode: a single HTTP server handles both the WebSocket
 * bridge (browser SDK) and the SSE MCP transport (Claude/agent). Unlike start, the MCP
 * connection is not tied to the process lifetime — Claude reconnects across sessions while
 * browser sessions persist in the daemon.
 */
export async function startDaemon(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  let pushHarnessConfig: (root: string) => void = () => undefined;
  const configForRoot = harnessConfigsByRoot(loadHarnessConfig, (root) => pushHarnessConfig(root));
  // The SAME line as in `start`, because these are two entry points that each wire their own world
  // and the daemon is the one that actually serves people. Wired only in `start`, the impact record
  // was never opened in the process the HUD talks to: tool calls still recorded (the dispatch
  // chokepoint opens it lazily), but a tab that connected before the first tool call was pushed
  // nothing, so the report read "nothing recorded yet" over a file with history in it.
  initImpact({
    sdkVersion: SERVER_VERSION,
    reticleRoot: options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT),
    // The daemon owns both sides of this seam, so it is the layer that may join them: the cache
    // lives in cloud memory, the platform read lives in the harness feature, and neither is allowed
    // to reach for the other.
    configForRoot,
    coverageForRoot: (root: string) => () => coveragePercents(root),
  });

  const security = await resolveBridgeSecurityWithAutoToken(options);
  const shared = createSharedServer(security.token === undefined ? {} : { token: security.token });
  const bridge = new Bridge({
    port,
    server: shared.httpServer,
    sdkFix: sdkFixForProject,
    ...security,
  });
  const repaint = (only?: string, ifChanged = false): void => {
    for (const session of bridge.sessions.all()) {
      const root =
        session.artifactRoot ?? options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT);
      if ((only ?? root) === root) pushIfMoved(session, () => impactSnapshot(root), ifChanged);
    }
  };
  pushHarnessConfig = repaint;
  // The daemon owns listen (below), so the real bind error is reported there; absorb bridge.ready's
  // mirror rejection so a port collision can't surface as an unhandled promise rejection.
  void bridge.ready.catch(() => undefined);
  // Declared before attachStatus so the closure below can report it; assigned further down, before
  // listen — the first status request cannot arrive until after the bind.
  let verifyHttp: { server: Server; port: number } | undefined;
  // `reticle status` GETs this for a live, at-a-glance view of connected tabs + their health.
  // It carries the same diagnosis agents get on an empty `reticle_sessions`, so an empty status
  // answers WHY rather than just "sessionCount: 0".
  // `verifyPort` rides along so a later `serve --http` can tell whether this daemon already honours
  // the requested `--http-port` instead of silently ignoring the flag (#687).
  shared.attachStatus((held) => {
    // `init` holds the daemon it is waiting on, so the idle rule cannot shut it down mid-wait.
    if (held) noteSetupHold(Date.now());
    return statusPayload(
      bridge.sessions.count(),
      bridge.sessions.list(),
      bridge.sessions.noSessionHint(),
      verifyHttp?.port,
      bridge.sessions.noSessionLead(),
      bridge.sessions.all(),
    );
  });
  // Agent-independent presence: the daemon outlives any single agent, so when the LAST agent's MCP
  // connection drops (it stopped, or is waiting on the human), end every session and push a clear
  // "go to your terminal" notice to the panel — the human is on the browser and must not lose a typed
  // prompt into a dead session. A returning agent's next tool call revives the auto-ended session.
  // Track agent presence for the idle-shutdown predicate (below): the daemon is "idle" only when no
  // agent is attached AND no browser tab is connected AND no pool lease is active.
  let agentConnected = false;
  shared.attachAgentPresence((connected) => {
    agentConnected = connected;
    if (!connected) endAllSessions(bridge.sessions, AGENT_STOPPED_NOTICE);
  });

  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();
  const { realInput, owned } = await resolveRealInput(
    options,
    () => shared.close(),
    makeNetworkDetailRouter(bridge, options.driveUrl),
  );

  const fs = createNodeFileSystem();
  const reticleRoot = options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT);
  const now = options.now ?? ((): number => Date.now());
  const retain = readRetainPolicy(findProjectConfig(process.cwd()));
  // See the sibling path: `retain.sessions: 0` stops the capture too, not only the sweep.
  const journalEnabled =
    readJournalEnabled(process.cwd(), process.env[ReticleEnv.JOURNAL]) && 0 < retain.sessions;
  // A saved flow wakes sync like a landed run: see FlowStore's `onWrote`.
  const flows = new FlowStore(fs, reticleRoot, { now }, { onWrote: () => syncNudge.run?.() });
  // Built here rather than inside `deps` below, so teardown can save what a drive recorded. Both
  // paths pass the same pair — `daemon-parity.test.ts` is what keeps them from drifting apart.
  const recordings = new RecordingStore(() => currentDrivenBy() !== undefined);
  /*
   * Bound AFTER the sync daemon exists, read only when a run is actually written.
   *
   * `attachJournal` runs before `attachCloudSync` because the journal has to be capturing before
   * anything can connect, and reordering them so this could be a direct reference would put sync
   * setup ahead of session capture for the sake of one callback.
   */
  const syncNudge: { run?: () => void } = {};
  const endLiveSessions = attachJournal(bridge, {
    fs,
    reticleRoot,
    enabled: journalEnabled,
    retain,
    takeAmbientTape: (sessionId) => recordings.takeAmbient(sessionId),
    reportStep: reportOnboardingStep,
    flows,
    author: flowAuthor,
    onRunPersisted: () => syncNudge.run?.(),
  });
  const project = new ProjectStore(fs, reticleRoot, { now });
  attachRouteLearning(bridge, projectStoreResolver(fs, project, reticleRoot, now));
  const annotations = new AnnotationStore();
  const pool = createBrowserPool(options.headless ?? true, readerConnect(port, security.token));
  const leaseReaper = new LeaseReaper(pool);
  leaseReaper.start();
  /*
   * Automatic cloud sync, for the session nobody thinks about.
   *
   * The daemon outlives every individual tool call and is already running for the whole session, so
   * it is the only place "keep the dashboard current while work is happening" costs nobody an extra
   * process to remember. Safe for an UNLINKED project: it resolves the link on every tick and does
   * nothing until one exists, so `reticle link` takes effect without a restart.
   */
  /*
   * Hooks, attached for the life of the daemon — the same call `start` makes, see `wireHooks`.
   *
   * Wired here rather than lazily on first use because the events it listens for start the moment a
   * session attaches, and a surface that wires itself up on first need would miss exactly the
   * events a user most wants: the ones at the start of a run.
   */
  wireHooks(reticleRoot, readProjectId(process.cwd()));
  const cloudSync = attachCloudSync({
    fs,
    reticleRoot,
    homeDir: homedir(),
    env: process.env,
    otherRoots: knownProjectRoots,
  });
  syncNudge.run = (): void => cloudSync.nudge();
  // `syncNow`, not `nudge` (a cycle soon): somebody is watching the button. Never awaited.
  bridge.attachSyncRequest(() => void cloudSync.syncNow());
  if (options.hudSignIn !== undefined)
    bridge.attachSigninRequest(options.hudSignIn(repaint, projectLinkOnly(options.hudLink)));
  // Logout and link run in another process: repaint when their files change, the rest on a timer.
  const accountFiles = watchAccountFiles(repaint, undefined, () => repaint(undefined, true));
  accountFiles.watch(join(homedir(), ReticleDir.ROOT, SESSION_FILE));
  bridge.attachSessionReady((s) =>
    accountFiles.watch(join(s.artifactRoot ?? reticleRoot, ReticleDir.CLOUD_LINK_FILE)),
  );
  attachHudHarness(
    bridge,
    { deps: () => deps, root: reticleRoot, repaint: () => repaint() },
    (r, on) => applyHarnessSwitch(configForRoot, r, on, platformEnvFor(r)),
    options.hudLink,
  );
  // Scope auto-selection to the active project (from .reticle.json) so a stray tab from another app is
  // never picked when the agent omits a sessionId. Explicit per-call scope/sessionId still overrides.
  // Scope + the no-session diagnosis: "no browser session connected" is the error that ends most
  // sessions, and the agent is told to check two things it cannot see. See no-session-diagnosis.ts.
  // Ordered AFTER the pool: the watch may open a browser itself the moment it finds a listening dev
  // server for a wired project (see no-session-watch.ts), and it opens it through the pool — the same
  // path reticle_lease takes, in this process, binding nothing.
  wireSessionScope(
    bridge.sessions,
    readProjectId(process.cwd()),
    port,
    (sessionId) => pool.wasReapedLease(sessionId),
    (url) => pool.acquire(url),
  );
  const leaseUrl = (url: string): Promise<unknown> =>
    runTool(LEASE_ACQUIRE_TOOL, effectiveDeps, { url });
  const deps = {
    sessions: bridge.sessions,
    pool,
    baselines: new BaselineStore(),
    // The SAME store teardown reads, not a second one. A second store means the tools capture into
    // one tape and the teardown saves from another, so every automatic flow would be empty while
    // every check on the tape passed — the tape it checked just was not the one being driven.
    recordings,
    annotations,
    flows,
    project,
    fs,
    reticleRoot,
    linkedCloud: linkedCloudPort(fs, reticleRoot, homedir(), process.env),
    // The long-lived daemon needs this MORE than the standalone MCP process does, not less: it is
    // the one that outlives a single project and serves every app on the machine. Omitting it here
    // silently disabled per-session artifact resolution for every agent that attaches to a running
    // daemon — the common case — so flows were listed, loaded and healed against wherever the
    // daemon happened to be launched. Wired in only one of the two places, a resolver is a resolver
    // that does not run.
    artifactRootFor: artifactRootResolver(reticleRoot, { servingDirectory: servingDirectoryOf }),
    now,
    bridgePort: port,
    browserProbe: probeLaunchableChromium,
    ...agentWiring(port, bridge.sessions, leaseUrl),
    // A finished verification should not sit behind a one-minute timer — see ToolDeps.onRunPersisted.
    onRunPersisted: (): void => cloudSync.nudge(),
    syncNow: () => cloudSync.syncNow(),
  };
  const profile = resolveToolSurface(options.toolProfile);
  const effectiveDeps = realInput !== undefined ? { ...deps, realInput } : deps;
  // Read per attach, not once: a project that gets wired while this daemon is alive should stop
  // being told to wire itself on the next agent that connects.
  shared.attachMcp((peerSkew) =>
    createMcpServer(
      peerSkew === undefined
        ? effectiveDeps
        : { ...effectiveDeps, peerSkew: connectionSkew(peerSkew) },
      profile,
      instructionStateAt(port, bridge.sessions.count()),
    ),
  );
  shared.attachDrive(leaseUrl); // `reticle drive <url>` — see cli/drive/drive-attach.ts.
  // The platform chat's apps and drives, run here. See chat-drives.ts.
  const chatDrives = startChatDrives(
    effectiveDeps,
    bridge.sessions,
    fs,
    {
      sessionCloud: sessionCloudPort(fs, homedir(), process.env, (id) =>
        sessionRoot(effectiveDeps, id),
      ),
      version: SERVER_VERSION,
      unsynced: () => cloudSync.unsyncedRoots(),
    },
    log,
  );

  // Optional OEM/CI verify endpoint: a host platform POSTs to /verify and gets an ReticleVerificationRun,
  // driving the same flow-replay machinery the agent uses — no MCP stdio, no human. Each verdict is
  // persisted via RunStore. Localhost-bound + token-guarded. Off unless `reticle serve --http`.
  // (`verifyHttp` itself is declared above attachStatus, which reports its port.)
  if (true === options.httpVerify) {
    // Wakes cloud sync when the HTTP verify server persists a run — that path does not push
    // inline the way the MCP one does, so without this its runs waited for the timer.
    const runStore = new RunStore(fs, reticleRoot, { onWrote: () => cloudSync.nudge() });
    const runner = new ReticleRunner(createRunnerPort(effectiveDeps));
    const token = options.httpVerifyToken ?? process.env[ReticleEnv.VERIFY_TOKEN] ?? '';
    verifyHttp = await startVerifyServer(
      { runner, token, persist: (run) => runStore.write(run) },
      options.httpVerifyPort ?? RETICLE_VERIFY_DEFAULT_PORT,
    );
    log('reticle_verify_http_started', { port: verifyHttp.port, tokenRequired: token.length > 0 });
  }

  // Replay-from-panel: the human clicks ▶ on a saved flow; run it with NO agent and narrate the
  // verdict into the same activity log they watch the agent in. The page animates via the normal
  // replay path, so they see it re-drive and the ✓/⚠/✗ land.
  bridge.attachReplay((sessionId, flowName) => {
    if (bridge.sessions.get(sessionId) === undefined) return;
    void replayFromHud(effectiveDeps, (id) => bridge.sessions.get(id), sessionId, flowName);
  });
  // On connect, hand the panel the replayable flows so it can render the ▶ list. Scoped to the
  // connecting session's project (a shared daemon serves many apps; each panel shows only its own
  // flows + legacy untagged ones). Each chip carries a `start` hint (the first step's testid anchor)
  // so the HUD shows a flow only on the page it can begin from — the panel re-scopes per route.
  // The first instrumented app of this daemon run.
  // Inside the existing session-ready hook rather than beside it: this fires exactly when a page
  // carrying the SDK has completed its handshake, which is the definition of "instrumented", and
  // `reportAppInstrumented` is idempotent so later sessions cost a boolean check.
  bridge.attachSessionReady(() => {
    reportAppInstrumented({
      initialized: readProjectId(process.cwd()) !== undefined,
      agentAttached: agentConnected,
    });
  });

  bridge.attachSessionReady((session) => {
    flows
      .list(session.projectId)
      .then(async (names) => {
        const loaded = await Promise.all(names.map((name) => flows.load(name, session.projectId)));
        const files = loaded.flatMap((r) => (r.ok ? [r.value] : []));
        await session.command(ReticleCommand.FLOWS, {
          flows: buildFlowChips(files, session.projectId),
        });
      })
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

  // `localhost` is a name with two answers, and Windows/Chrome tries the IPv6 one first. Only alias
  // when we are on the default loopback bind: an explicit RETICLE_HOST is a deliberate choice about
  // reachability, and quietly adding a second listener to it would be the opposite of deliberate.
  const loopbackAlias =
    security.host === undefined
      ? await openLoopbackAlias(port)
      : { opened: false, close: undefined };

  log('mcp_daemon_started', { port, loopbackAlias: loopbackAlias.opened });

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    ...(verifyHttp !== undefined ? { verifyPort: verifyHttp.port } : {}),
    ...(security.token !== undefined ? { token: security.token } : {}),
    // Nobody is using this daemon — self-shuts-down once it holds for the grace window. See
    // daemon-usefulness.ts for the two ways that can be true.
    isIdle: buildIdlePredicate(() => agentConnected, bridge.sessions, pool),
    // Exposed so the shutdown watcher can give an ATTACHED daemon a longer grace. The predicate above
    // says WHETHER it is idle; this says how long that quiet should be tolerated — see idle-grace.
    agentAttached: () => agentConnected,
    announceShutdown: () => shared.announceShutdown(),
    close: async () => {
      reaper.stop();
      await cleanupCaptureDirectories();
      const vh = verifyHttp;
      if (vh !== undefined) await new Promise<void>((resolve) => vh.server.close(() => resolve()));
      leaseReaper.stop();
      chatDrives.stop();
      accountFiles.close();
      await endLiveSessions(); // first: an open tab's teardown writes the flow this flush sends
      await cloudSync.flush(); // not stop(): the last run written is the one nobody has yet
      await loopbackAlias.close?.();
      await pool.shutdown();
      await owned?.dispose();
      await bridge.close();
      await shared.close();
    },
  };
}

// The OpenVerification binding, exported so a conformance run can be driven from outside this
// package: a `WebRealm` needs a live `Session`, which exists only inside a running daemon.
export { WebRealm, type WebRealmDeps } from './portal/realm/web-realm.js';
export { conformanceClient, type ConformanceClient } from './portal/realm/conformance-client.js';

/**
 * The MCP server factory, so a consumer can serve the tool surface it composed.
 *
 * Without this the composition seam is unreachable from outside the package: a consumer can build the
 * list and has nothing to hand it to.
 */
export { createMcpServer } from './surface/mcp/mcp.js';
export type {
  Contradiction,
  ContradictionOptions,
} from '@reticlehq/engine/disagreement/contradictions.js';
export {
  registerContradictionFold,
  registeredContradictionFolds,
} from '@reticlehq/engine/disagreement/contradiction-folds.js';
export type { ContradictionFold } from '@reticlehq/engine/disagreement/contradiction-folds.js';
export { MCP_SSE_PATH, MCP_MESSAGE_PATH } from '@reticlehq/core';
export { BrowserPool, DEFAULT_LEASE_TTL_MS } from './portal/pool/browser-pool.js';
export type { Lease, Launcher, PooledBrowser } from './portal/pool/browser-pool.js';
export { playwrightLauncher, resolveMaxContexts } from './portal/pool/playwright-launcher.js';
export { appendReticleParams } from './surface/tools/lease-tools.js';
export {
  writePid,
  removePid,
  isRunning,
  logPath,
  readPid,
  isAlive,
} from './command/daemon/daemon.js';
// The daemon's own liveness vocabulary, exported so a GATE can read a daemon log back and say how
// that daemon ended. Without this the battery would re-implement the rule, and a guard that
// re-implements what it guards is insensitive to it.
export {
  classifyDaemonLife,
  DaemonEnd,
  DAEMON_HEARTBEAT_EVENT,
  DAEMON_HEARTBEAT_MS,
  type DaemonLife,
} from './command/daemon/lifetime/heartbeat.js';
export type {
  CrawlReport,
  CrawlAnomaly,
  CrawlOptions,
  CrawlSession,
} from './features/crawl/crawl.js';
export { scrollToFind } from './portal/input/scroll-find.js';
export type {
  ScrollFindResult,
  ScrollFindQuery,
  ScrollFindSession,
} from './portal/input/scroll-find.js';
export {
  CORE_TOOL_NAMES,
  TOOL_SURFACE,
  TOOL_PROFILE_ENV,
  filterTools,
  resolveToolSurface,
} from './surface/tools/tool-surface.js';
export type { ToolSurface } from './surface/tools/tool-surface.js';
export { AnnotationStore } from './language/flows/stores/annotation-store.js';
export { replayFlow, nearestTestid } from './language/flows/flow-replay.js';
export type { FlowReplaySession, WaitForSignal } from './language/flows/flow-replay.js';
export {
  ensureReticleDir,
  writeContract,
  readContract,
  reticleDirPaths,
  flowPath,
  baselinePath,
} from './memory/project/dir/reticle-dir.js';
export type { ReticleDirPaths, ReadContractResult } from './memory/project/dir/reticle-dir.js';
export { createNodeFileSystem } from './memory/project/fs/fs-port.js';
export type { FileSystemPort } from './memory/project/fs/fs-port.js';
// Replay/Verify API — the programmatic surface an OEM/CI pipeline drives (see docs/platform-integration.md).
export { ReticleRunner } from './judgement/runs/reticle-runner.js';
export type { RunnerPort, VerifyOptions } from './judgement/runs/reticle-runner.js';
export { createRunnerPort, defaultRunId } from './judgement/runs/runner-port.js';
export {
  buildVerificationRun,
  computeVerdict,
} from './judgement/runs/artifact/build-verification-run.js';
export type { VerificationRunInput } from './judgement/runs/artifact/build-verification-run.js';
export { RunStore } from './judgement/runs/artifact/run-store.js';
export type { ReadRunResult } from './judgement/runs/artifact/run-store.js';
export { classifyChangedFiles, buildRisks, risksForPath } from './judgement/runs/risk-classify.js';
export type { ChangedFileInput, RiskPolicy } from './judgement/runs/risk-classify.js';
export { buildRepairPacket, buildRepairPackets } from './judgement/runs/repair-prompt.js';
export { redactForProfile, REDACTED } from './judgement/runs/artifact/profile-redact.js';
export { renderRunReport } from './judgement/runs/artifact/render-report.js';
export { handleVerifyRequest, tokenOk, VERIFY_PATH } from './judgement/runs/verify-http.js';
export type { VerifyHttpRequest, VerifyHttpResponse } from './judgement/runs/verify-http.js';
export {
  createVerifyRequestListener,
  startVerifyServer,
  TOKEN_HEADER,
} from './judgement/runs/verify-server.js';
export type { VerifyServerOptions } from './judgement/runs/verify-server.js';
export {
  evaluatePredicate,
  waitForPredicate,
  PredicateSchema,
} from '@reticlehq/engine/question/predicate/predicate.js';
export type { Predicate, EvalResult } from '@reticlehq/engine/question/predicate/predicate.js';
export { buildReactionReport } from '@reticlehq/engine/question/reaction.js';
export {
  CdpRealInputProvider,
  LaunchedRealInputProvider,
  DriveError,
  performGesture,
  boxCenter,
  isPointerAction,
} from './portal/input/real-input.js';
export type {
  RealInputProvider,
  OwnedRealInputProvider,
  LaunchFn,
  LaunchedProviderOptions,
  ElementBox,
  RealInputArgs,
} from './portal/input/real-input.js';

// Hooks, in-process half. The config half needs no export: a user writes `.reticle/hooks.json`.
// Payload TYPES live in `@reticlehq/core/hooks`; `hook-bus.ts` has the design.
export { onHook as onReticleEvent, emitHook, hookListenerCount } from './hooks/hook-bus.js';
export type { HookListener } from './hooks/hook-bus.js';
export { readHookConfig } from './hooks/hook-commands.js';

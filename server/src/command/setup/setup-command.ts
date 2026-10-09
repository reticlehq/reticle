/**
 * The wire: everything init established, plus the world, plus the phases.
 *
 * Kept apart from cli.ts so the assembly is readable in one place and so `handleInit` stays the
 * three lines it was. The only decision here is which effects to hand over; the sequencing lives in
 * run-setup.ts and the pieces it calls.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planAgentConfigs, type PlatformPaths } from './agent-configs.js';
import { AppShape, describeShape, readShape } from './desktop-shape.js';
import { stopOnInterrupt } from './terminal/interrupt.js';
import { stopOnCrash, crashSentence } from './terminal/crash.js';
import { applyAgentPlan, applyAgentSkills } from './agent-writer.js';
import { ApprovalOutcome, grantAutoApproval } from './auto-approve.js';
import { agentIo } from './agent-io.js';
import {
  EnsureDaemon,
  ensureDaemon,
  holdDaemon,
  nodeEnsureDaemonDeps,
  nodeRetireDeps,
  retireMovedDaemons,
} from './bringup/ensure-daemon.js';
import { openInBrowser } from '@/command/cli/launch/cli-launch.js';
import { openLeaseFor } from './bringup/connect-lease.js';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';
import { spawnSync } from 'node:child_process';
import { isAlive, reticleStateHome } from '@/command/daemon/daemon.js';
import { readDevServers } from '@/command/daemon/dev-servers.js';
import { urlOfExistingApp } from './probe/existing-app.js';
import { handedOverUrl, stopHandedOver } from './bringup/dev-server-files.js';
import { listSessions, OwnedDevServer, probePage } from './node-effects.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { daemonSkew, summarizeStatus } from '@/command/cli/launch/cli-launch.js';
import {
  runSetupPhases,
  SetupPhase,
  type SetupEffects,
  type SetupInput,
  type SetupOutcome,
} from './run-setup.js';
import { noticeKey, readSaid, rememberSaid, unsaidNotices } from './agent-notice-memory.js';

/**
 * The dev server a crash should take with it, if one is running right now.
 *
 * A `let` rather than a parameter because the crash handler is installed at the CLI entry point —
 * a bug of ours can fire in any phase, and the first attempt at this installed the handler inside
 * the runtime phase, where it caught nothing in either environment I tried: init had already
 * returned. Only this phase ever owns a detached server, so only this phase fills it in.
 */
let activeDevServerStop: (() => void) | null = null;

/** Stop the dev server setup started, if it is still running. Safe to call when there is none. */
export function stopRunningDevServer(): void {
  activeDevServerStop?.();
}

/** Where a crash of our own leaves its trace. Never a stream — see terminal/crash.ts. */
const CRASH_LOG_NAME = '.reticle-setup-crash.log';

/**
 * Catch our own faults for the whole process, and take the dev server with them.
 *
 * Here rather than in `cli/`, where it started: the handler it installs lives in `terminal/`, and
 * `cli` is not allowed to reach that directory. `directory-reach` was right to refuse it — the
 * installer stops the dev server THIS file owns, so this is where it belonged all along.
 *
 * Installed at the CLI entry rather than inside the phase below, because a fault can fire in any
 * phase: the first attempt sat inside the runtime phase and caught nothing in two different
 * environments, because init had already returned by the time the handler existed.
 */
export function installCrashGuard(): () => void {
  return stopOnCrash(stopRunningDevServer, process, (message, stack) => {
    const crashLog = join(process.cwd(), CRASH_LOG_NAME);
    try {
      writeFileSync(crashLog, stack);
    } catch {
      /* an unwritable directory is not worth a second crash */
    }
    process.stderr.write(`${crashSentence(message, crashLog)}\n`);
  });
}

interface SetupCommandInput extends Omit<SetupInput, 'shape'> {
  /** Where setup was invoked, which is not the app directory in a monorepo. */
  readonly invokedAt: string;
  readonly bridgePort: number;
  readonly env: Readonly<Record<string, string>>;
  /** Register the MCP server with the coding agents init does not itself reach. */
  readonly registerAgents: boolean;
  /** The bridge's pairing token, for the MCP transport a connect-proof lease is opened over. */
  readonly pairingToken?: string | undefined;
  /** False for `--no-first-run`: connect, and say nothing more. */
  readonly firstRun: boolean;
  /** `--json`: an agent is reading, so nothing is driven on its behalf. */
  readonly json: boolean;
  /**
   * What happens once the connection is proved: the coverage summary and the agent prompt. A port,
   * because it reads the daemon's status and the link, which this directory does not reach for.
   */
  readonly firstFlow?: FirstFlowPort | undefined;
}

/** init's ending, as `command/cli/try-command.ts` says it. Structural, so setup imports nothing. */
export type FirstFlowPort = (
  ctx: {
    appDir: string;
    bridgePort: number;
    pairingToken?: string | undefined;
    url: string;
    sessionId: string;
    leased: boolean;
    openBrowser: boolean;
    firstRun: boolean;
    json: boolean;
  },
  say: (line: string) => void,
) => Promise<{ flowSaved: boolean }>;

/** `electron` in either dependency list, read the same way init's desktop doctor reads it. */
function hasElectronDependency(dir: string): boolean {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if ('object' !== typeof pkg || null === pkg) return false;
    const p = pkg as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return undefined !== { ...p.dependencies, ...p.devDependencies }['electron'];
  } catch {
    return false;
  }
}

/**
 * Register with the agents `init` does not reach, and leave the skill where one loads skills from.
 *
 * init covers eight clients and only where it finds them installed, which leaves VS Code's USER
 * scope unwritten — it exists on machines today, and init only ever writes the project-scope file,
 * so a VS Code user has no tools outside the directory they ran init in.
 */
/** `agent`, `agents`. */
const agentWord = (n: number): string => (1 === n ? 'agent' : 'agents');

/** Returns how many agents it wrote a config for, so a caller does not then say "none found". */
export function registerOtherAgents(print: (line: string) => void): number {
  const platform = process.platform as keyof PlatformPaths;
  const home = homedir();
  const results = applyAgentPlan(
    planAgentConfigs({ home, platform, exists: agentIo.exists, readFile: agentIo.readFile }),
    agentIo,
  );
  const wrote = results.filter((r) => 'created' === r.action || 'merged' === r.action);
  if (0 < wrote.length) {
    print(
      `  ✓ ${String(wrote.length)} more ${agentWord(wrote.length)}: ${wrote.map((r) => r.name).join(', ')}`,
    );
  }
  // A format we will not rewrite is somebody's to edit, so it has to be said rather than skipped --
  // but said ONCE. Two commands call this function by design, so a `curl | sh` followed by
  // `reticle init` printed the same two paragraphs twice in one sitting, and again on every re-run
  // after that. See agent-notice-memory.ts: the stamp is keyed on the notice's own text, so a
  // config that changes is reported again.
  const stateHome = reticleStateHome();
  const manual = results
    .filter((r) => 'manual' === r.action)
    .map((r) => ({ name: r.name, file: r.file, why: r.why }));
  const fresh = unsaidNotices(readSaid(stateHome), manual);
  for (const notice of fresh) {
    print(`  ⚠ ${notice.name}: ${notice.why} — add the reticle entry to ${notice.file} by hand.`);
  }
  rememberSaid(
    stateHome,
    fresh.map((n) => noticeKey(n)),
  );
  const skills = applyAgentSkills(agentIo, { home, platform });
  if (0 < skills.length)
    print(`  ✓ the /reticle skill, for ${String(skills.length)} ${agentWord(skills.length)}`);

  // Registration alone still leaves an Accept dialog in front of every call, and a verification run
  // makes dozens of them: the loop is only autonomous once the tools are pre-approved.
  const approvals = grantAutoApproval(agentIo, { home, platform });
  const granted = approvals.filter((a) => ApprovalOutcome.GRANTED === a.outcome);
  if (0 < granted.length) {
    print(
      `  ✓ tools pre-approved in ${granted.map((a) => a.name).join(', ')}, so no Accept prompt per call`,
    );
  }
  for (const noted of approvals.filter((a) => undefined !== a.warn)) {
    print(`  ⚠ ${noted.name}: ${String(noted.warn)}`);
  }
  return wrote.length;
}

type SetupCommandResult = SetupOutcome;

/**
 * Run the phases against the real world.
 *
 * The dev server is stopped on every ending except success, where it is handed to the user: an
 * instrumented app they can watch is the deliverable, and killing it would leave them with config
 * files and a dead tab.
 */
/** How long a stopped dev server gets to let go of its port before the new one is started. */
const HANDED_OVER_EXIT_MS = 10_000;
const HANDED_OVER_EXIT_POLL_MS = 100;

/** Stop the server a previous init handed over for `appDir`, and wait (bounded) for it to exit. */
async function restartHandedOverServer(appDir: string): Promise<boolean> {
  let stoppedPid: number | undefined;
  const stopped = stopHandedOver(reticleStateHome(), appDir, {
    alive: isAlive,
    kill: (pid) => {
      stoppedPid = pid;
      try {
        // Its own process group (it was spawned detached), so what it started goes with it.
        if ('win32' === process.platform) {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
        } else {
          process.kill(-pid, 'SIGTERM');
        }
      } catch {
        /* already gone */
      }
    },
  });
  const deadline = Date.now() + HANDED_OVER_EXIT_MS;
  while (undefined !== stoppedPid && isAlive(stoppedPid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, HANDED_OVER_EXIT_POLL_MS));
  }
  return stopped;
}

/**
 * init's ending, inside the dev server's lifetime: coverage is read off the open tab, and the `finally`
 * in `runSetupCommand` only stops a server that was not handed over. Its lines join the notes, so
 * `--json` carries the next step too.
 */
async function afterConnect(
  input: SetupCommandInput,
  url: string,
  sessionId: string,
  outcome: SetupOutcome,
  print: (line: string) => void,
): Promise<Pick<SetupOutcome, 'flowSaved' | 'notes'>> {
  const notes = [...outcome.notes];
  if (input.firstFlow === undefined) return { flowSaved: false, notes };
  const { flowSaved } = await input.firstFlow(
    {
      appDir: input.appDir,
      bridgePort: input.bridgePort,
      pairingToken: input.pairingToken,
      url,
      sessionId,
      leased: true === outcome.leased,
      openBrowser: input.openBrowser,
      firstRun: input.firstRun,
      json: input.json,
    },
    (line) => {
      notes.push(line);
      print(line);
    },
  );
  return { flowSaved, notes };
}

export async function runSetupCommand(
  input: SetupCommandInput,
  print: (line: string) => void,
): Promise<SetupCommandResult> {
  if (input.registerAgents) registerOtherAgents(print);

  // A moved port first: this project's daemon on the OLD port would otherwise be the one the page
  // finds and dials, while everything below waits on the new one.
  const retired = await retireMovedDaemons(
    readProjectId(input.appDir),
    input.bridgePort,
    nodeRetireDeps(),
  );
  for (const port of retired) {
    print(
      `stopped this project's Reticle daemon on port ${String(port)}: the project now uses ` +
        `${String(input.bridgePort)}, and the page would have kept dialling the old one.`,
    );
  }
  // And the dev server a previous init left running, which may have read the old port once at
  // startup (Next does) — so the attach below would keep a page dialling the daemon just stopped.
  if (0 < retired.length && (await restartHandedOverServer(input.appDir))) {
    print(
      `stopped the dev server a previous init started, so it restarts on port ${String(input.bridgePort)}.`,
    );
  }

  // Before the app is booted, because the app's whole job from here is to dial this port. Without
  // it the phases wait out their budget and then report the SDK as the thing that failed.
  const daemon = await ensureDaemon(
    input.bridgePort,
    nodeEnsureDaemonDeps((status) => undefined !== daemonSkew(status)),
  );
  if (undefined !== daemon.message) print(daemon.message);
  if (EnsureDaemon.SKEWED_IN_USE === daemon.state) {
    // Stop here: every hello from the page would be refused, and waiting out the connect budget
    // only to blame the page is the run this exists to prevent.
    return {
      ok: false,
      reachedPhase: SetupPhase.DEV_SERVER,
      flowSaved: false,
      notes: undefined === daemon.message ? [] : [daemon.message],
      fallback: [
        `Once those sessions are done, free the port with \`npx @reticlehq/server kill --port ${String(input.bridgePort)}\` and re-run init.`,
      ],
    };
  }
  if (EnsureDaemon.UNAVAILABLE === daemon.state) {
    print(
      `could not start the Reticle daemon on port ${String(input.bridgePort)}, so nothing is listening for the app to connect to. Run \`npx @reticlehq/server serve --port ${String(input.bridgePort)}\` and try again.`,
    );
  }

  // Which shell this is decides three things the phases would otherwise get wrong: opening a
  // browser (harmful for desktop, where the app's own window is the client), waiting for an HTTP
  // port (a Tauri webview has none), and how long the app gets to appear (a cold `tauri dev` builds
  // Rust first). The same evidence init's desktop doctor reads.
  const shape = readShape({
    hasTauriConf: existsSync(join(input.appDir, 'src-tauri', 'tauri.conf.json')),
    hasElectronDep: hasElectronDependency(input.appDir),
  });
  if (AppShape.WEB !== shape) print(`detected ${describeShape(shape)}`);

  const server = new OwnedDevServer();

  const effects: SetupEffects = {
    startDevServer: (command, cwd) => {
      print(`starting: ${command}`);
      server.start(command, cwd, input.env);
      return Promise.resolve();
    },
    // The server the plugin announced (Vite), or failing that the one a previous init handed over
    // and recorded — the only way to know a Next or Angular server on the port is this project's own.
    existingAppUrl: async () =>
      urlOfExistingApp(readDevServers(reticleStateHome()), {
        projectId: readProjectId(input.appDir),
        root: input.appDir,
      }) ??
      (await handedOverUrl(reticleStateHome(), input.appDir, {
        alive: isAlive,
        answers: async (url) => (await probePage(url)).served,
      })),
    devServerOutput: () => server.output(),
    devServerExited: () => server.exited(),
    devServerQuietForMs: () => server.quietForMs(),
    observedPorts: () => server.listeningPorts(),
    probePage,
    openBrowser: async (url) => {
      const failure = await openInBrowser(url);
      if (null === failure) return undefined;
      // It used to end "nothing else here will open one", which stopped being true once a
      // Reticle-owned browser could always launch: run-setup opens a lease on this failure, so the
      // reader is told what happens next rather than sent to find a browser by hand.
      print(
        `could not open a browser (${failure}), so the connect proof will come from a ` +
          `Reticle-owned headless browser instead. To use the app yourself, point any browser at ${url}.`,
      );
      return failure;
    },
    openLease: (url) => openLeaseFor(input.bridgePort, url, input.pairingToken),
    listSessions: () => listSessions(input.bridgePort),
    // `summarizeStatus` already narrows this payload for `reticle status`; reusing it here keeps one
    // reader of the wire shape rather than two that can disagree about which key carries the reason.
    // Both lengths, from the one read: the lead is printed to the person watching the install, the
    // full differential is recorded for the agent reading `--json`. Returning only the lead here is
    // what emptied the agent surface — see the note at the call site in `run-setup.ts`.
    daemonWhy: async () => {
      const status = summarizeStatus(await fetchStatus(input.bridgePort));
      const full = status.why;
      // A daemon too old to report the short one falls back to the long one, because saying the
      // right thing at length beats saying nothing.
      const lead = status.whyLead ?? full;
      if (undefined === lead) return undefined;
      return undefined === full ? { lead } : { lead, full };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    note: print,
  };

  // A `finally` does not run on SIGINT, and this phase owns a detached dev server — see interrupt.ts.
  const releaseSignals = stopOnInterrupt(() => {
    server.stop();
  }, process);
  // The crash handler lives at the CLI entry, because a bug of ours can fire in any phase — but
  // only this one owns a detached dev server, so this is where it learns what to stop.
  activeDevServerStop = () => {
    server.stop();
  };
  // Hold the daemon for as long as this run waits on it. Its idle rule counted none of this as
  // activity, and on a slow desktop build the daemon init had just started idled out mid-wait.
  const releaseDaemon = holdDaemon(input.bridgePort);
  try {
    const outcome = await runSetupPhases(
      { ...input, shape, projectId: readProjectId(input.appDir) },
      effects,
    );
    // The app stays up only when there is something worth watching.
    if (outcome.ok) {
      server.handOver(outcome.url);
      // Its output is on a file now, not this terminal, so say where: a compile error that used to
      // scroll past here is the first thing somebody will look for.
      const log = server.logPath();
      if (undefined !== log) print(`The dev server keeps running; its output goes to ${log}`);
    }
    if (!outcome.ok || undefined === outcome.url || undefined === outcome.sessionId) return outcome;
    return {
      ...outcome,
      ...(await afterConnect(input, outcome.url, outcome.sessionId, outcome, print)),
    };
  } finally {
    releaseDaemon();
    releaseSignals();
    activeDevServerStop = null;
    server.stop();
  }
}

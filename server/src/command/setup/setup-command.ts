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
import { AppShape, readShape } from './desktop-shape.js';
import { stopOnInterrupt } from './terminal/interrupt.js';
import { stopOnCrash, crashSentence } from './terminal/crash.js';
import { applyAgentPlan, applyAgentSkills } from './agent-writer.js';
import { ApprovalOutcome, grantAutoApproval } from './auto-approve.js';
import { agentIo } from './agent-io.js';
import { EnsureDaemon, ensureDaemon, nodeEnsureDaemonDeps } from './bringup/ensure-daemon.js';
import { openInBrowser } from '@/command/cli/launch/cli-launch.js';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';
import { reticleStateHome } from '@/command/daemon/daemon.js';
import { readDevServers } from '@/command/daemon/dev-servers.js';
import { urlOfExistingApp } from './probe/existing-app.js';
import { listSessions, OwnedDevServer, probePage } from './node-effects.js';
import {
  runSetupPhases,
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
}

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
export function registerOtherAgents(print: (line: string) => void): void {
  const platform = process.platform as keyof PlatformPaths;
  const home = homedir();
  const results = applyAgentPlan(
    planAgentConfigs({ home, platform, exists: agentIo.exists, readFile: agentIo.readFile }),
    agentIo,
  );
  const wrote = results.filter((r) => 'created' === r.action || 'merged' === r.action);
  if (0 < wrote.length) {
    print(
      `registered the MCP server with ${wrote.length} more agent(s): ${wrote.map((r) => r.name).join(', ')}`,
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
    print(`${notice.name}: ${notice.why} — add the reticle entry to ${notice.file} by hand.`);
  }
  rememberSaid(
    stateHome,
    fresh.map((n) => noticeKey(n)),
  );
  const skills = applyAgentSkills(agentIo, { home, platform });
  if (0 < skills.length) print(`wrote the /reticle skill for ${skills.length} agent(s)`);

  // Registration alone still leaves an Accept dialog in front of every call, and a verification run
  // makes dozens of them: the loop is only autonomous once the tools are pre-approved.
  const approvals = grantAutoApproval(agentIo, { home, platform });
  const granted = approvals.filter((a) => ApprovalOutcome.GRANTED === a.outcome);
  if (0 < granted.length) {
    print(
      `pre-approved the reticle tools in ${granted.map((a) => a.name).join(', ')} — no Accept prompt per call`,
    );
  }
  for (const noted of approvals.filter((a) => undefined !== a.warn)) {
    print(`${noted.name}: ${String(noted.warn)}`);
  }
}

type SetupCommandResult = SetupOutcome;

/**
 * Run the phases against the real world.
 *
 * The dev server is stopped on every ending except success, where it is handed to the user: an
 * instrumented app they can watch is the deliverable, and killing it would leave them with config
 * files and a dead tab.
 */
export async function runSetupCommand(
  input: SetupCommandInput,
  print: (line: string) => void,
): Promise<SetupCommandResult> {
  if (input.registerAgents) registerOtherAgents(print);

  // Before the app is booted, because the app's whole job from here is to dial this port. Without
  // it the phases wait out their budget and then report the SDK as the thing that failed.
  const daemon = await ensureDaemon(input.bridgePort, nodeEnsureDaemonDeps());
  if (EnsureDaemon.UNAVAILABLE === daemon) {
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
  if (AppShape.WEB !== shape) print(`detected a ${shape} app`);

  const server = new OwnedDevServer();

  const effects: SetupEffects = {
    startDevServer: (command, cwd) => {
      print(`starting: ${command}`);
      server.start(command, cwd, input.env);
      return Promise.resolve();
    },
    existingAppUrl: () =>
      Promise.resolve(
        urlOfExistingApp(readDevServers(reticleStateHome()), {
          projectId: readProjectId(input.appDir),
          root: input.appDir,
        }),
      ),
    devServerOutput: () => server.output(),
    devServerExited: () => server.exited(),
    devServerQuietForMs: () => server.quietForMs(),
    observedPorts: () => server.listeningPorts(),
    probePage,
    openBrowser: async (url) => {
      const failure = await openInBrowser(url);
      if (null !== failure) {
        print(
          `could not open a browser (${failure}). Nothing was opened, and nothing else here will ` +
            // Three wordings have been wrong in a row, each naming a way out that does not exist on
            // the machine being spoken to. It said `reticle_run({ tool: "reticle_lease", ... })`:
            // the default surface advertises neither name and ships no hatch to reach the second.
            // It then said `reticle open <url>`, which asks the OS to launch the default browser --
            // the very thing that just failed -- so it returned the reader to the same wall.
            // This one names no command: the missing piece is a browser, and the honest sentence
            // says which url needs one rather than inventing a Reticle that can conjure it.
            `open one: this asks the OS for your default browser, and it is a machine with none — ` +
            `CI, a container, an SSH session, WSL with no host browser. Point any browser that can ` +
            `reach it at ${url}; the session appears within a second of the page loading.`,
        );
      }
    },
    listSessions: () => listSessions(input.bridgePort),
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
  try {
    const outcome = await runSetupPhases({ ...input, shape }, effects);
    // The app stays up only when there is something worth watching.
    if (outcome.ok) server.handOver();
    return {
      ...outcome,
    };
  } finally {
    releaseSignals();
    activeDevServerStop = null;
    server.stop();
  }
}

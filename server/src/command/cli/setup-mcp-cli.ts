import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mcpLauncher } from '@/command/setup/mcp-launcher.js';
import { probeCli, terminalWidth, wrapForTerminal } from '@reticlehq/init';
import { tutorialShownSteps } from './tutorial.js';
import { setupMcp, knownClientLabels, type SetupMcpIo } from '@/command/setup/setup-mcp.js';
import { reportInstallSteps } from '@/command/setup/setup-install.js';
import { registerOtherAgents } from '@/command/setup/setup-command.js';
import type { OnboardingStep } from '@reticlehq/core/telemetry';
import {
  agentLines,
  agentRows,
  awaitedClients,
  claudeConfigDir,
  claudePluginActive,
  connectionLines,
  waitForAgents,
  type AgentRow,
} from '@/command/setup/agent-next-steps.js';
import { connectedAgentClients } from '@/surface/mcp/peer/agents-connected.js';
import { reticleStateHome } from '@/command/daemon/daemon.js';

/**
 * The terminal half of `reticle setup mcp`.
 *
 * The decision it makes and the IO it needs are split, so the decision is testable without a home
 * directory — the same shape `init` uses, and for the same reason: every setup bug worth catching
 * has been in what gets WRITTEN and where, which is exactly the part a real filesystem hides.
 */
/**
 * The reporter arrives from the CALLER, one more level up than it feels like it should.
 *
 * `cli/` does not reach `telemetry/` and adding that edge made a mutual pair — two directories that
 * each need the other cannot be read, moved or tested apart. `command/` already reaches telemetry,
 * so the entry point supplies it and every layer below stays a function of its arguments.
 */
export type StepReporter = (step: OnboardingStep) => void;

/** How many coding agents on this machine have Reticle's tools after this run. */
export function handleSetupMcp(
  reportStep: StepReporter,
  standalone = true,
  /** Wait for the agents to connect. The caller decides: a terminal, and not CI. */
  waitForConnect = false,
): number {
  const io: SetupMcpIo = {
    launcher: mcpLauncher(),
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (p, contents) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contents);
    },
    homeDir: () => homedir(),
    print: (line) => process.stdout.write(`${wrapForTerminal(line, terminalWidth())}\n`),
    reportStep,
    // `probeCli`, not a bare `execFileSync`: on Windows `claude` is a `.cmd` shim that cannot be
    // spawned without a shell, so the plain call threw ENOENT for every Windows user and the
    // installer reported their machine had no coding agent on it. init has always spawned through
    // the shell-and-quoting rules `probeCli` carries; this used to be a second copy without them.
    // A refusal is still not fatal — the other clients register, and calling one refusal a failed
    // run would hide the ones that worked.
    runCli: (command, args) => probeCli(command, args),
  };

  const result = setupMcp(io);

  if (0 === result.detected.length) {
    // Even with no file-backed client, the broader set may still have somewhere to write.
    const preRegistered = registerOtherAgents((line) => {
      io.print(line);
    });
    // Named rather than a bare "none found". A person whose agent IS installed needs to know
    // whether we looked for it at all, and the list is the difference between "we did not find
    // yours" and "we do not support yours". When the broader set was written, saying "none found"
    // right under its tick read as a contradiction: those agents are pre-registered, not found.
    io.print(
      0 < preRegistered
        ? `None of ${knownClientLabels().join(', ')} is installed here yet. The agents above are pre-registered and have Reticle's tools once installed; install one of the others, then run \`reticle setup mcp\` again.`
        : `No coding agent config found. Looked for: ${knownClientLabels().join(', ')}. Install one, then run \`reticle setup mcp\` again.`,
    );
    return 0;
  }
  const rows = agentRows(result, claudePluginActive(claudeConfigDir()), io.launcher);
  for (const line of agentLines(rows)) {
    io.print(line);
  }
  if (result.failed.length > 0) {
    process.exitCode = 1;
  }
  /*
   * The OTHER agents, which `init` already reaches and this did not.
   *
   * There are two registration paths and I shipped one: `MCP_CLIENTS` covers eight file-backed
   * clients, and `registerOtherAgents` covers the rest — VS Code's USER scope, Zed, Copilot CLI,
   * Warp, Kiro, Amazon Q, Cline, Amp, Continue, Factory Droid. Found by running the installer and
   * `init` back to back in one sandbox: the installer said "registered cursor" and init then said
   * "registered the MCP server with 10 more agent(s)".
   *
   * "Set up the MCP everywhere" has to mean everywhere, and an installer that reaches fewer agents
   * than `init` sends somebody to a project directory to finish a job that had no reason to be
   * half-done.
   */
  registerOtherAgents((line) => {
    io.print(line);
  });
  // Said on every run, attended or not: a registration only takes effect when the agent re-reads
  // its config, and an agent that was already open is the commonest reason "it did not work".
  // Only when this IS the whole command. Inside the installer the restart is the first line of the
  // closing's Next list, where it belongs with the other things to do, not between the stages.
  if (standalone) {
    io.print('');
    io.print('Then: cd <your project> && reticle init');
    if (waitForConnect) {
      void reportConnections(rows, (line) => {
        io.print(line);
      });
    }
  }
  return result.registered.length + result.alreadyThere.length;
}

/** How long the installer waits for an agent to connect. Short: the person may not restart now. */
const CONNECT_WAIT_MS = 60_000;
const CONNECT_POLL_MS = 1000;

/** Wait only where a person watches: a terminal, and not CI. */
export function shouldWaitForAgents(isTty: boolean | undefined, isCi: boolean): boolean {
  return true === isTty && !isCi;
}

/** Wait (bounded) for the registered agents to connect, then say which did and what is missing. */
async function reportConnections(
  rows: readonly AgentRow[],
  print: (line: string) => void,
): Promise<void> {
  const want = awaitedClients(rows);
  if (0 === want.length) {
    return;
  }
  print('');
  print(
    `Waiting up to ${String(CONNECT_WAIT_MS / 1000)}s for your agents to connect. Press Ctrl+C to skip.`,
  );
  const seen = await waitForAgents(
    want,
    () => connectedAgentClients(reticleStateHome()),
    {
      now: () => Date.now(),
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    },
    CONNECT_WAIT_MS,
    CONNECT_POLL_MS,
  );
  for (const line of connectionLines(rows, seen)) {
    print(line);
  }
}

/**
 * The one line the launchers read and strip: what they cannot know and the next steps depend on.
 *
 * The launchers own the closing words (served from main, so wording changes on merge) and used to
 * print "restart your coding agent" to a machine with none, and "cd your-app" to somebody already
 * standing in it. An older launcher shows this line as is; a launcher reading an older CLI finds no
 * line and keeps its generic wording, so neither half has to ship first.
 */
export const INSTALL_RESULT_PREFIX = 'RETICLE_INSTALL';
const APP_MARKERS = ['package.json', 'index.html'] as const;
/** Whether the folder the installer ran in is an app: `init` runs here, or after a `cd`. */
export const InstallAppHere = { HERE: 'here', NONE: 'none' } as const;

export function installResultLine(agents: number, cwd: string): string {
  const app = APP_MARKERS.some((file) => existsSync(join(cwd, file)))
    ? InstallAppHere.HERE
    : InstallAppHere.NONE;
  return `${INSTALL_RESULT_PREFIX} agents=${String(agents)} app=${app}`;
}

/**
 * `reticle setup install` — the Node half of the one-line installer.
 *
 * Reports what the shell measured, then does the thing the shell deliberately does not: register
 * with the coding agents on this machine. One implementation, so the Windows launcher is a handful
 * of lines that cannot meaningfully drift from this one.
 */
export function handleSetupInstall(
  opts: { runtimeSecs: number; installSecs: number; mcp: boolean },
  reportStep: StepReporter,
): void {
  reportInstallSteps({ runtimeSecs: opts.runtimeSecs, installSecs: opts.installSecs }, reportStep);
  let agents = 0;
  if (opts.mcp) {
    agents = handleSetupMcp(reportStep, false);
  } else {
    process.stdout.write('Skipping MCP registration (--no-mcp).\n');
  }
  // No closing here: the installer prints the next step and the agent prompt itself, right after
  // this returns, so what this prints is progress and nothing else. Those two blocks are what the
  // ONBOARD steps below now stand for: what Reticle is for, shown before anything is asked of anyone.
  for (const step of tutorialShownSteps()) {
    reportStep(step);
  }
  process.stdout.write(`${installResultLine(agents, process.cwd())}\n`);
}

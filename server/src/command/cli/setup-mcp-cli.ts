import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setupMcp, knownClientLabels, type SetupMcpIo } from '../setup/setup-mcp.js';
import { reportInstallSteps } from '../setup/setup-install.js';
import { registerOtherAgents } from '../setup/setup-command.js';
import type { OnboardingStep } from '@reticlehq/core/telemetry';

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

export function handleSetupMcp(reportStep: StepReporter): void {
  const io: SetupMcpIo = {
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
    print: (line) => process.stdout.write(`${line}\n`),
    reportStep,
    runCli: (command, args) => {
      try {
        execFileSync(command, [...args], { stdio: 'ignore' });
        return true;
      } catch {
        // The client's own CLI refused or is not installed. Not fatal: the others still register,
        // and reporting one refusal as a whole-run failure would hide the ones that worked.
        return false;
      }
    },
  };

  const result = setupMcp(io);

  if (0 === result.detected.length) {
    // Even with no file-backed client, the broader set may still have somewhere to write.
    registerOtherAgents((line) => {
      io.print(line);
    });
    // Named rather than a bare "none found". A person whose agent IS installed needs to know
    // whether we looked for it at all, and the list is the difference between "we did not find
    // yours" and "we do not support yours".
    io.print(`No coding agent config found. Looked for: ${knownClientLabels().join(', ')}.`);
    io.print('Install one, then run `reticle setup mcp` again.');
    return;
  }
  for (const id of result.registered) io.print(`  registered  ${id}`);
  for (const id of result.alreadyThere) io.print(`  already     ${id}`);
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
  io.print('');
  io.print('Restart your agent for it to pick up the new server.');
  io.print('Then: cd <your project> && reticle init');
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
  if (opts.mcp) {
    handleSetupMcp(reportStep);
  } else {
    process.stdout.write('Skipping MCP registration (--no-mcp).\n');
  }
  process.stdout.write('\n');
  process.stdout.write('Reticle is installed. Next:\n');
  process.stdout.write('  cd <your project> && reticle init     # wire it into the app\n');
  process.stdout.write(
    '  reticle tutorial                      # what Reticle is, in two minutes\n',
  );
}

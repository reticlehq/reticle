import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { probeCli } from '@reticlehq/init';
import { installClosing, tutorialShownSteps } from './tutorial.js';
import { setupMcp, knownClientLabels, type SetupMcpIo } from '../setup/setup-mcp.js';
import { reportInstallSteps } from '../setup/setup-install.js';
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
    // Named rather than a bare "none found". A person whose agent IS installed needs to know
    // whether we looked for it at all, and the list is the difference between "we did not find
    // yours" and "we do not support yours".
    io.print(`No coding agent config found. Looked for: ${knownClientLabels().join(', ')}.`);
    io.print('Install one, then run `reticle setup mcp` again.');
    return;
  }
  for (const id of result.registered) io.print(`  registered  ${id}`);
  for (const id of result.alreadyThere) io.print(`  already     ${id}`);
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
  // A person gets the tour; a pipe gets the pointer. See installClosing for why the TTY decides.
  const showTour = true === process.stdout.isTTY;
  process.stdout.write(`${installClosing(showTour)}\n`);
  // Only claim the ONBOARD steps when the tour was actually put in front of somebody. Reporting
  // them for a piped install would record a journey nobody took, which is the one thing a funnel
  // must never do.
  if (showTour) for (const step of tutorialShownSteps()) reportStep(step);
}

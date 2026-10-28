/**
 * The safe repairs `reticle doctor --fix` can apply, in the order it applies them.
 *
 * Each one changes only Reticle's own state, and each reuses the code that already owns that state:
 * `removePid` for the pid file, `stopWedgedDaemon` for a stuck daemon, the launch path's pinned
 * install for Chromium, and `reticle setup mcp` for the agent registrations. The facts each one
 * reads are injected, so the decision is tested without a home directory or a port.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { claudeAvailableProbe, codexAvailableProbe, probeCli } from '@reticlehq/init';
import { isAlive, readPid, removePid } from '@/command/daemon/daemon.js';
import { PortPresence, probePresence } from '@/command/daemon/binding/port-presence.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { identifyPortHolder } from '@/command/daemon/port-state.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { probeChromiumWithFallback, probeLaunchableChromium } from '@/launch-chromium.js';
import { setupMcp } from '@/command/setup/setup-mcp.js';
import { handleSetupMcp, type StepReporter } from './setup-mcp-cli.js';
import { stopWedgedDaemon } from './cli-kill.js';
import { captureLookup, type PortHolder } from './ports/port-holder.js';
import {
  bundledPlaywrightVersion,
  chromiumInstallCommand,
  type ChromiumProbe,
} from './doctor/browser/chromium-hint.js';
import { DoctorRow, doctorRow } from './doctor/doctor-rows.js';
import type { DoctorRepair } from './doctor/doctor-fix.js';
import { launcherLine, registeredEntries } from './doctor/doctor-launcher-line.js';

const SETUP_MCP_COMMAND = 'reticle setup mcp';

/** A pid file whose process is gone. `removePid` itself never removes the file of a live process. */
export function stalePidRepair(deps: {
  readPid: () => number | null;
  isAlive: (pid: number) => boolean;
  removePid: () => void;
}): DoctorRepair {
  const needed = (): boolean => {
    const pid = deps.readPid();
    return pid !== null && !deps.isAlive(pid);
  };
  return {
    row: DoctorRow.DAEMON,
    what: 'pid file of a stopped daemon',
    step: 'delete the pid file of the stopped daemon in ~/.reticle',
    needed: () => Promise.resolve(needed()),
    apply: () => {
      deps.removePid();
      return Promise.resolve();
    },
  };
}

/**
 * A Reticle daemon that holds the port and does not answer. Only a holder whose command line is a
 * Reticle daemon's qualifies; `stopWedgedDaemon` checks that again, after a grace period, before it
 * sends a signal. A stranger and the agent's own `reticle mcp` proxy are never stopped.
 */
export function wedgedDaemonRepair(
  port: number,
  deps: {
    presence: () => Promise<PortPresence>;
    holder: () => PortHolder | null;
    stop: () => Promise<boolean>;
  },
): DoctorRepair {
  return {
    row: DoctorRow.DAEMON,
    what: 'a Reticle daemon that does not answer',
    step: `reticle restart --port ${String(port)}`,
    needed: async () =>
      PortPresence.FOREIGN === (await deps.presence()) && true === deps.holder()?.reticleDaemon,
    apply: async () => {
      await deps.stop();
    },
  };
}

/**
 * No browser that a launch can use. Only when Playwright's own build is missing or at the wrong
 * revision and no installed Chrome or Edge stands in. A RETICLE_CHROMIUM_PATH the user set is never
 * replaced, and an absent playwright package is not a download this can fix.
 */
export function chromiumRepair(deps: {
  probe: () => Promise<ChromiumProbe>;
  install: () => Promise<unknown>;
  /** The bundled playwright's version, which pins the manual install command. */
  playwrightVersion: string | undefined;
}): DoctorRepair {
  return {
    row: DoctorRow.CHROMIUM,
    what: "Playwright's own Chromium",
    step: chromiumInstallCommand(deps.playwrightVersion),
    needed: async () => {
      const probe = await deps.probe();
      return (
        !probe.exists &&
        probe.fallback === undefined &&
        true !== probe.configured &&
        probe.executablePath !== undefined
      );
    },
    apply: async () => {
      await deps.install();
    },
  };
}

/** Agents found on this machine that do not have Reticle's MCP server registered. */
export function mcpRepair(deps: {
  gaps: () => readonly string[];
  register: () => void;
}): DoctorRepair {
  return {
    row: DoctorRow.MCP,
    what: 'agent registrations',
    step: SETUP_MCP_COMMAND,
    needed: () => Promise.resolve(deps.gaps().length > 0),
    apply: () => {
      deps.register();
      return Promise.resolve();
    },
  };
}

/** How the launcher row starts its command, as `doctor-launcher-line.ts` writes it. */
const LAUNCHER_RUN = 'Run: ';

/**
 * An agent config starts Reticle from an installed copy that no longer exists. `setup mcp`
 * replaces Reticle's own entry in the JSON clients. It keeps an existing Claude Code entry, so for
 * Claude Code the row still fails after the repair, and the step is the row's remove-then-add.
 */
export function launcherRepair(deps: {
  /** The launcher row, or undefined when every registered launcher exists. */
  line: () => string | undefined;
  register: () => void;
}): DoctorRepair {
  let step = SETUP_MCP_COMMAND;
  return {
    row: DoctorRow.LAUNCHER,
    what: 'a registered launcher that does not exist',
    // The step is read after `needed`, which reads the row again.
    get step() {
      return step;
    },
    needed: () => {
      const line = deps.line();
      if (line === undefined) {
        return Promise.resolve(false);
      }
      const at = line.indexOf(LAUNCHER_RUN);
      step = at < 0 ? SETUP_MCP_COMMAND : line.slice(at + LAUNCHER_RUN.length);
      return Promise.resolve(true);
    },
    apply: () => {
      deps.register();
      return Promise.resolve();
    },
  };
}

/** The launcher row for the agent configs of this machine and folder. */
export function readLauncherLine(cwd: string): string | undefined {
  return launcherLine(
    registeredEntries(
      {
        exists: existsSync,
        homeDir: homedir,
        readFile: (p) => {
          try {
            return readFileSync(p, 'utf8');
          } catch {
            return null;
          }
        },
      },
      cwd,
    ),
    existsSync,
  );
}

/** Which agents found here have Reticle, and which do not. */
export interface McpRegistration {
  readonly missing: readonly string[];
  readonly present: readonly string[];
}

/** The `mcp` doctor row. */
export function mcpRegistrationRow(registration: McpRegistration): string {
  const { missing, present } = registration;
  if (missing.length > 0) {
    const also = 0 === present.length ? '' : ` (registered with ${present.join(', ')})`;
    return doctorRow(
      DoctorRow.MCP,
      `✗ not registered with ${missing.join(', ')}; run \`${SETUP_MCP_COMMAND}\`${also}`,
    );
  }
  if (0 === present.length) {
    return doctorRow(
      DoctorRow.MCP,
      `no agent that this check knows was found; \`${SETUP_MCP_COMMAND}\` names the agents it knows`,
    );
  }
  return doctorRow(DoctorRow.MCP, `✓ registered with ${present.join(', ')}`);
}

/**
 * Ask `setupMcp` what it would do, and do none of it. Config writes and registration commands are
 * recorded, not run; only the two `--version` probes run, because they say whether an agent is here.
 * No telemetry: this is a check, not a registration.
 */
export function readMcpRegistration(): McpRegistration {
  const probes = [claudeAvailableProbe(), codexAvailableProbe()];
  const isProbe = (command: string, args: readonly string[]): boolean =>
    probes.some((p) => p.command === command && p.args.join(' ') === args.join(' '));
  const result = setupMcp({
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: () => {},
    homeDir: () => homedir(),
    print: () => {},
    runCli: (command, args) => (isProbe(command, args) ? probeCli(command, args) : true),
    reportStep: () => {},
  });
  return { missing: result.registered, present: result.alreadyThere };
}

/** The repairs for this machine and port, in the order `--fix` applies them. */
export function machineRepairs(port: number, reportStep: StepReporter): DoctorRepair[] {
  return [
    stalePidRepair({
      readPid: () => readPid(port),
      isAlive,
      removePid: () => {
        removePid(port);
      },
    }),
    wedgedDaemonRepair(port, {
      presence: () => probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus }),
      holder: () => identifyPortHolder(port, captureLookup),
      stop: () => stopWedgedDaemon(port),
    }),
    chromiumRepair({
      probe: () => probeChromiumWithFallback(),
      install: () => probeLaunchableChromium(),
      playwrightVersion: bundledPlaywrightVersion(),
    }),
    // Before `mcp`: its `setup mcp` also replaces a stale launcher, and this one says so.
    launcherRepair({
      line: () => readLauncherLine(process.cwd()),
      register: () => {
        handleSetupMcp(reportStep, false);
      },
    }),
    mcpRepair({
      gaps: () => readMcpRegistration().missing,
      register: () => {
        handleSetupMcp(reportStep, false);
      },
    }),
  ];
}

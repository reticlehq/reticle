import { existsSync, readFileSync } from 'node:fs';
import { keychainNoteFor } from './doctor/doctor-signing-line.js';
import { join } from 'node:path';
import { devServersForProject, ReticleEnv } from '@reticlehq/core';
import { readPid, reticleStateHome } from '@/command/daemon/daemon.js';
import { PortPresence, probePresence } from '@/command/daemon/binding/port-presence.js';
import { isLocalhostSplit, probeLoopbackReach } from '@/command/daemon/binding/loopback-reach.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { fetchStatus, summarizeStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { daemonLine, type DaemonIdentity } from './doctor/doctor-daemon-line.js';
import { projectWiringLine } from './doctor/doctor-project-line.js';
import { hasProjectConnectedBefore } from '@/memory/recall/prior/connection-memory.js';
import { sessionsLine, type SessionsLine } from './doctor/doctor-sessions-line.js';
import { captureLookup, describeForeignHolder } from './ports/port-holder.js';
import { identifyPortHolder } from '@/command/daemon/port-state.js';
import { chromiumHint } from './doctor/browser/chromium-hint.js';
import { probeChromiumWithFallback } from '@/launch-chromium.js';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import {
  CspBasis,
  diagnoseDesktop,
  diagnoseObservedWebCsp,
  diagnoseWebCsp,
  isDesktopProject,
  resolveWebCspFindings,
  webCspOptionsFor,
} from '@reticlehq/init';
import {
  RETICLE_CONFIG_BASENAME,
  diagnosePortMismatch,
  readProjectFramework,
  readProjectId,
  readProjectPort,
} from './ports/resolve/cli-port.js';
import { DoctorRow, doctorRow } from './doctor/doctor-rows.js';
import { ReticleDir } from '@reticlehq/core';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import { BackgroundSyncState, backgroundSyncGate } from '@/memory/cloud/background-sync.js';
import { readCloudState } from '@/memory/cloud/sync-disk.js';
import { signedInTo } from './auth/cloud-session.js';
import { claudeCliHere, projectDirOf, promptCaptureRows } from './hook/hook-command.js';
import { coverageLines } from './doctor/doctor-coverage-line.js';
import { homedir } from 'node:os';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { describeUnsynced } from '@/memory/cloud/unsynced-roots.js';
import { machineUnsyncedRoots } from '@/memory/project/sync-status.js';
import { attachState, describeAttachState } from '@/surface/mcp/attach-memory.js';
import { agentLinkText } from './doctor/doctor-agent-link.js';
import { countNeeded, fixFooter, runDoctorFix } from './doctor/doctor-fix.js';
import {
  machineRepairs,
  mcpRegistrationRow,
  readLauncherLine,
  readMcpRegistration,
} from './doctor-repairs.js';
import type { StepReporter } from './setup-mcp-cli.js';
import { findOccupiedSiblings, siblingListenerNote } from './ports/sibling-ports.js';
import {
  daemonsServingProjectElsewhere,
  resolveDaemonForProject,
  splitBrainNote,
  wrongDaemonNote,
} from '@/command/daemon/daemon-resolve.js';
import { isAlive } from '@/command/daemon/daemon.js';
import { readDevServers } from '@/command/daemon/dev-servers.js';
import {
  hasConnectedDocument,
  observeWebDocument,
} from '@/portal/session/dev-server/served-document.js';

/**
 * `reticle doctor` — collapse the ~6 independent first-run failure modes into one command. Checks the
 * Chromium install (the #1 silent failure), whether a daemon is up on the resolved bridge port, and
 * reminds the user which port the app must dial. Human-readable to stdout (not the JSON log).
 */

/** Narrow the `/status` payload to the two fields the daemon line reads. */
function asIdentity(payload: unknown): DaemonIdentity {
  if (typeof payload !== 'object' || null === payload) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return 'string' === typeof value && value.length > 0 ? value : undefined;
  };
  // Keys are OMITTED rather than set to undefined: `exactOptionalPropertyTypes` is on, and the
  // distinction is the point — "this daemon did not say" is not the same as "this daemon said none".
  const version = pick('version');
  const contract = pick('contract');
  return {
    ...(version === undefined ? {} : { version }),
    ...(contract === undefined ? {} : { contract }),
  };
}

/**
 * One project, two daemons — asked from whichever end this command is standing on.
 *
 * Shares the rule with `reticle status` rather than restating it: the empty daemon can see that the
 * app connected somewhere else, the daemon holding the app can only see that this project owns
 * another one, and a second copy of either half would be a second opinion waiting to disagree.
 */
function splitBrainLine(port: number, projectId: string | undefined): string | undefined {
  const home = reticleStateHome();
  const elsewhere = splitBrainNote(
    port,
    daemonsServingProjectElsewhere(projectId, port, home, isAlive, (other) =>
      hasProjectConnectedBefore(home, other, projectId),
    ),
  );
  return elsewhere ?? wrongDaemonNote(port, resolveDaemonForProject(projectId, home, isAlive));
}

const writeLine = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/**
 * `reticle doctor`, and with `fix`, `reticle doctor --fix`. Without `fix` it changes nothing and
 * ends with how many rows `--fix` can repair. With `fix` the exit code is 1 while any row fails.
 */
export async function handleDoctor(
  port: number,
  fix = false,
  reportStep: StepReporter = () => {},
): Promise<void> {
  const repairs = machineRepairs(port, reportStep);
  if (fix) {
    const green = await runDoctorFix({
      doctor: (show) => doctorLines(port, show),
      repairs,
      print: writeLine,
    });
    if (!green) {
      process.exitCode = 1;
    }
    return;
  }
  await doctorLines(port, true);
  const footer = fixFooter(await countNeeded(repairs));
  if (footer !== undefined) {
    writeLine('');
    writeLine(footer);
  }
}

/** Every doctor row, in order. Each row is printed as it is found when `show` is true. */
async function doctorLines(port: number, show: boolean): Promise<string[]> {
  const lines: string[] = [];
  const line = (s: string): void => {
    lines.push(s);
    if (show) {
      writeLine(s);
    }
  };
  line('reticle doctor');
  line(doctorRow(DoctorRow.NODE, process.version));
  // Filled in only on the daemon branch — there is nothing to ask when no daemon is answering, and
  // the branches below already say so in their own terms.
  let sessions: SessionsLine | undefined;
  let daemonStatus: unknown;
  line(doctorRow(DoctorRow.CHROMIUM, chromiumHint(await probeChromiumWithFallback())));
  line(mcpRegistrationRow(readMcpRegistration()));
  // Ask the PORT, not just the pid file. "not running on :4400" has been printed about a port that
  // was demonstrably occupied, which sends the reader to start a daemon that cannot bind. The three
  // states are genuinely different problems with different fixes, so doctor names which one it is.
  const pid = readPid(port);
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (presence === PortPresence.DAEMON) {
    // Name WHICH daemon. The /status payload already carries version + contract, and doctor was
    // throwing both away — while skew is invisible everywhere else, reaching the agent as a bare
    // -32000 naming no version. This is the command a human runs at exactly that moment.
    const payload = await fetchStatus(port);
    daemonStatus = payload;
    const status = asIdentity(payload);
    const built = daemonLine(port, pid, status, {
      version: SERVER_VERSION,
      contract: CONTRACT_FINGERPRINT,
    });
    line(built.text);
    if (built.skew !== undefined) {
      line(doctorRow(DoctorRow.VERSION, `✗ ${built.skew}`));
    }
    // The same payload already carries whether anything has CONNECTED, and doctor was reading
    // `version` off it and dropping the rest. Without this the command is silent on the one step the
    // funnel stalls on: wired correctly, daemon up, and no page has ever dialled in.
    sessions = sessionsLine('object' === typeof payload && null !== payload ? payload : {});
    // Only meaningful with a daemon answering: this asks which ADDRESS it answers on. `localhost` is
    // a name with two answers and Windows Chrome tries the IPv6 one first, so a daemon that is up,
    // healthy and bound to 127.0.0.1 alone is unreachable at the URL the SDK is told to dial. The
    // alias that forwards `[::1]` is best-effort by contract, and its failure was recorded only as a
    // field on one JSON log line — so every other row here goes green while the page cannot connect.
    const reach = await probeLoopbackReach(port);
    if (isLocalhostSplit(reach)) {
      line(
        doctorRow(
          DoctorRow.LOOPBACK,
          `✗ :${port} answers on 127.0.0.1 but NOT on [::1], and \`localhost\` tries [::1] first on ` +
            'Windows — so a page told to dial `localhost` cannot reach this daemon. Dial ' +
            `\`127.0.0.1:${port}\` explicitly, or free whatever holds [::1]:${port}.`,
        ),
      );
    }
  } else if (presence === PortPresence.FOREIGN) {
    // Name the holder when we can. `doctor` exists for exactly this moment, and "another process"
    // leaves the reader to find a shell command themselves — the obvious one being the `lsof -ti`
    // pipeline that also kills the agent's own MCP proxy.
    // `pid` is what our pid file recorded for this port. When it matches the process actually
    // holding it, this is our OWN daemon wedged, not a stranger — and the fix is different.
    line(
      doctorRow(
        DoctorRow.DAEMON,
        `✗ ${describeForeignHolder(port, identifyPortHolder(port, captureLookup), pid)}`,
      ),
    );
  } else {
    line(
      doctorRow(
        DoctorRow.DAEMON,
        `✗ not running on :${port} — your agent runs \`reticle mcp\` (or \`reticle serve\`)`,
      ),
    );
  }
  if (sessions !== undefined) {
    line(sessions.text);
  }
  for (const row of coverageLines(daemonStatus)) {
    line(row);
  }
  // Runs nothing will send, named by folder with the one command that sends them.
  for (const entry of await machineUnsyncedRoots(createNodeFileSystem(), homedir(), process.env)) {
    line(doctorRow(DoctorRow.UNSYNCED, `✗ ${describeUnsynced(entry, process.cwd())}`));
  }
  line(
    doctorRow(
      DoctorRow.BRIDGE_PORT,
      `${port}  (your app must dial THIS port, not your dev-server port)`,
    ),
  );
  const projectPort = readProjectPort(process.cwd());
  const mismatch = diagnosePortMismatch(port, projectPort);
  if (mismatch !== undefined) {
    line(doctorRow(DoctorRow.PORT_CHECK, `✗ ${mismatch}`));
  }

  const projectId = readProjectId(process.cwd());
  // The hop between the agent and this daemon, stated as its own row rather than inferred from the
  // ones above it. `sessions` says the BROWSER reached the daemon; nothing said whether the AGENT
  // did, and those two are exactly the pair a user cannot tell apart when one of them is broken.
  const attach = attachState(reticleStateHome(), port);
  const attachAction = describeAttachState(attach);
  // A SPLIT outranks the attach record, and this is the one place it can. Both records are per PORT,
  // so on a machine whose daemons have split in two the attach row reports "nothing has ever
  // attached here" and sends the reader to re-register a server that is registered and running —
  // the confident wrong answer for a link that is not missing but misaimed.
  const split = splitBrainLine(port, projectId);
  // The record alone cannot answer whether the link works NOW (#1710): when the port is held
  // but `/status` does not answer, the record below would still read healthy or blame the
  // client, while the daemon row above already names the one fix for the held port. So in that
  // state the agent link row only points back at the daemon row instead of repeating the
  // record or adding a second command. No probe runs here: `/status` and `/mcp/sse` share one
  // HTTP server, so silence on `/status` already answers the MCP question, and an SSE connect
  // would flip agent presence on a daemon with no agents attached.
  const foreign = presence === PortPresence.FOREIGN;
  line(doctorRow(DoctorRow.AGENT_LINK, agentLinkText({ split, attachAction, foreign })));
  const launcher = readLauncherLine(process.cwd());
  if (launcher !== undefined) {
    line(doctorRow(DoctorRow.LAUNCHER, launcher));
  }
  // Remaining half of #261. The SDK dialling a port we are not on is invisible as a refused inbound,
  // but a listener on a well-known Reticle port is visible. Report the observation; do not conclude
  // it is the daemon this app wants — somebody else's daemon looks the same from here.
  const occupiedSiblings = await findOccupiedSiblings(port, probeDaemon);
  const siblingNote = siblingListenerNote(port, occupiedSiblings);
  if (siblingNote !== undefined) {
    line(doctorRow(DoctorRow.SIBLING, siblingNote));
  }
  // The check this checklist was missing: is the APP wired, not just the tools. Everything above can
  // be green in a project that has never been through `init`, and that combination is precisely the
  // one `doctor` gets run to explain.
  line(
    projectWiringLine({
      projectId,
      previouslyConnected: hasProjectConnectedBefore(reticleStateHome(), port, projectId),
      // An absent config and a corrupt one both read back as "no id"; only this tells them apart,
      // and telling somebody a file is missing while it sits in front of them is its own dead end.
      configPresent: existsSync(join(process.cwd(), RETICLE_CONFIG_BASENAME)),
    }),
  );
  // Are prompts reaching `.reticle/`, and is the work reaching the user's own workspace.
  for (const row of await captureAndSyncLines(process.cwd(), process.env)) {
    line(row);
  }
  // Where to LOOK when something is wrong. The daemon has always written a structured log here and
  // nothing ever said so, so the first move in every investigation was reading source instead of
  // reading the log. `RETICLE_TRACE=1` turns the same stream into a per-stage trace — see
  // docs/debugging.md.
  line(doctorRow(DoctorRow.DAEMON_LOG, join(reticleStateHome(), `daemon-${String(port)}.log`)));
  line(
    doctorRow(
      DoctorRow.TRACING,
      `${ReticleEnv.TRACE}=1 on the daemon for per-stage timings in that log`,
    ),
  );

  // Below the checklist rather than inline: it is a paragraph, and a paragraph in the middle of a
  // column of one-line checks buries the checks under it. This is the daemon's own no-session
  // diagnosis, the same one an agent gets from an empty reticle_sessions.
  if (sessions?.why !== undefined) {
    line('');
    line('  nothing has connected. What the daemon can tell from here:');
    line(`    ${sessions.why}`);
  }

  // Desktop setup RCA. Every one of these fails SILENTLY — a Tauri app with the default CSP runs
  // perfectly and never connects; an Electron app without the preload line reports zero network
  // activity forever, which reads as "makes no backend calls" rather than "you are blind to them".
  const readProjectFile = (relative: string): string | undefined => {
    try {
      return readFileSync(join(process.cwd(), relative), 'utf8');
    } catch {
      return undefined;
    }
  };
  // The web sibling of the desktop findings below: a `connect-src` that excludes the bridge makes
  // the browser refuse the WebSocket and report it in ITS console only, so every check above passes
  // at an app that can never connect. Named, with the exact text to paste.
  const devServers = devServersForProject(readDevServers(reticleStateHome()), {
    projectId,
    root: process.cwd(),
  });
  const observedDocuments = (
    await Promise.all(devServers.map((server) => observeWebDocument(server.url)))
  ).filter((document) => document !== undefined);
  const observedCsp =
    0 === observedDocuments.length
      ? undefined
      : observedDocuments.flatMap((document) => diagnoseObservedWebCsp(document, port));
  const connected = hasConnectedDocument(
    summarizeStatus(daemonStatus).sessions,
    devServers.map((server) => server.url),
    projectId,
  );
  const csp = resolveWebCspFindings({
    // With the wiring `init` recorded, so the two commands name the same rule for one policy.
    predicted: diagnoseWebCsp(
      readProjectFile,
      port,
      [],
      webCspOptionsFor(readProjectFramework(process.cwd())),
    ),
    ...(observedCsp === undefined ? {} : { observed: observedCsp }),
    connected,
  });
  if (csp.length > 0) {
    line('');
    const observed = csp.some((finding) => finding.basis === CspBasis.OBSERVED);
    line(
      observed
        ? `  csp          ✗ a Content-Security-Policy is blocking the Reticle bridge:`
        : `  csp          ? a configuration may block the Reticle bridge (predicted, not observed):`,
    );
    for (const finding of csp) {
      line(`                 ${finding.file}`);
      line(`                   ${finding.problem}`);
      line(`                   fix: ${finding.fix}`);
    }
  }

  const desktop = diagnoseDesktop(readProjectFile, port);
  if (desktop.length > 0) {
    line('');
    line(
      doctorRow(
        DoctorRow.DESKTOP,
        `✗ ${String(desktop.length)} issue(s) — the app will look fine and not work:`,
      ),
    );
    for (const finding of desktop) {
      line(`                 ${finding.file}`);
      line(`                   ${finding.problem}`);
      line(`                   fix: ${finding.fix}`);
    }
  } else if (isDesktopProject(readProjectFile)) {
    // Say so explicitly. Silence would read as "not checked", which is the same ambiguity the
    // findings above exist to remove.
    line(doctorRow(DoctorRow.DESKTOP, '✓ desktop wiring looks right'));
  }
  const keychain = keychainNoteFor({ read: readProjectFile });
  if (keychain !== undefined) {
    line(doctorRow(DoctorRow.DESKTOP, `⚠ ${keychain}`));
  }
  return lines;
}

/**
 * Two rows: does each agent hand its prompts to Reticle, and does the daemon send this
 * project's work in the background, and if not, why.
 *
 * Both answers come from the disk, the same files the hook and the daemon read, so `doctor` needs
 * no daemon to give them. A sync the platform refused shows as the last error the cycle recorded.
 */
async function captureAndSyncLines(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const home = homedir();
  const projectDir = projectDirOf(cwd);
  const lines = promptCaptureRows(projectDir, env, claudeCliHere()).map((row) =>
    doctorRow(DoctorRow.PROMPTS, row),
  );
  const reticleRoot = join(projectDir, ReticleDir.ROOT);
  const cloud = await resolveProjectCloud(createNodeFileSystem(), reticleRoot, home, env);
  const gate = backgroundSyncGate({
    reticleRoot,
    cloud,
    env,
    signedIn: (url) => signedInTo(join(home, ReticleDir.ROOT), url),
  });
  const state = readCloudState(reticleRoot);
  const on = BackgroundSyncState.ON === gate.state;
  const last =
    state.lastPushAt === undefined
      ? 'no push yet'
      : `last push ${new Date(state.lastPushAt).toISOString()}`;
  lines.push(doctorRow(DoctorRow.SYNC, `${on ? '✓ on' : '✗ off'}: ${gate.why}; ${last}`));
  if (state.lastError !== undefined) {
    lines.push(doctorRow(DoctorRow.SYNC, `✗ last error: ${state.lastError}`));
  }
  return lines;
}

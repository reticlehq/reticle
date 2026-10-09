/**
 * `reticle try <url>`: one free Harness drive of somebody's app, watched in a window, ending in a
 * plain list of which journeys work and which are broken.
 *
 * Sign-in comes first, and on purpose: the drive runs on the platform, so a machine that is not
 * linked could only be told no AFTER a browser had opened, which is the worst moment to say it.
 *
 * The decisions (refuse, ask the platform, drive, summarise, sync) are `runTry`, behind `TryPorts`, so
 * every branch is tested without a browser, a daemon or a network. The verdicts in the summary are the
 * engine's: a journey that neither passed nor failed is "not proved", never rounded up to "works".
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  RETICLE_DEFAULT_PORT,
  ReticleDir,
  ReticleEnv,
  RunFlowStatus,
  ScriptStatus,
  asRecord,
  driveFlowStatus,
} from '@reticlehq/core';
import type { CloudConfig } from '@/memory/cloud/cloud-sync.js';
import {
  FreeDriveKind,
  planUrl,
  requestFreeDrive,
  type FreeDrive,
} from '@/features/harness/platform/platform-drives.js';
import { linkedCloudPort, resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import { describeUnsynced, unsyncedRoots } from '@/memory/cloud/unsynced-roots.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '@/portal/bridge/pairing-token.js';
import { spawnDaemon } from '@/command/daemon/daemon.js';
import {
  PortPresence,
  describePresence,
  presenceIsUsable,
  probePresence,
} from '@/command/daemon/binding/port-presence.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { probeDaemon, waitForDaemonBind } from '@/surface/mcp/mcp-proxy.js';
import { readProjectPort } from '@/command/cli/ports/resolve/cli-port.js';
import { callerArtifactRoot } from '@/memory/project/link-directory.js';
import { seeRunLine } from '@/memory/project/sync-status.js';
import { DAEMON_INNER_COMMAND, PORT_FLAG } from '@/command/cli/cli-parse.js';
import {
  acquireLease,
  connectOverSse,
  endpointFor,
  exploreToEnd,
  refusalText,
  releaseLease,
  verdictOf,
} from '@/command/cli/adhoc-verdict.js';

export const MSG_SIGN_IN_FIRST = 'Sign in first: reticle connect (it is free, no card)';

const PERSONA_FLAG = '--persona';

/** The whole drive, model turns and browser included, before the CLI stops waiting for it. */
export const TRY_BUDGET_MS = 120_000;
/** Model turns in the one free drive. Bounds what it costs, not what it may find. */
export const TRY_MAX_STEPS = 40;
/** How long to wait for the daemon to write the drive's run once the tab is closed. */
const RUN_WRITE_WAIT_MS = 10_000;
const RUN_WRITE_POLL_MS = 250;

const EXIT_OK = 0;
const EXIT_FAIL = 1;

export interface TryJourney {
  title: string;
  status: string;
}

/** What one drive came back with, or the sentence that says why it could not run. */
export interface TryDrive {
  journeys: TryJourney[];
  runIds: string[];
  error?: string;
}

export interface TryPorts {
  /** The credential `reticle connect` filed for this folder, or null when it is not linked. */
  linked: () => Promise<CloudConfig | null>;
  requestDrive: (cloud: CloudConfig) => Promise<FreeDrive>;
  drive: (request: { url: string; driveId: string; persona?: string }) => Promise<TryDrive>;
  /** Send the drive's run, as `reticle push` does. True when the cycle succeeded. */
  sync: (runIds: readonly string[]) => Promise<boolean>;
  dashboardUrl: (cloud: CloudConfig) => Promise<string | undefined>;
  out: (line: string) => void;
  fail: (line: string) => void;
}

export interface TryArgs {
  url: string;
  persona?: string;
}

/** `try <url> [--persona <who>]`, or the sentence that says what is missing. */
export function parseTryArgs(argv: readonly string[]): TryArgs | { error: string } {
  let url: string | undefined;
  let persona: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === PERSONA_FLAG) {
      persona = argv[i + 1];
      if (persona === undefined) return { error: `${PERSONA_FLAG} needs a value` };
      i++;
    } else if (arg !== undefined && arg.startsWith('--')) {
      return { error: `unknown argument '${arg}'` };
    } else if (url === undefined) {
      url = arg;
    } else {
      return { error: `unknown argument '${String(arg)}'` };
    }
  }
  if (url === undefined) return { error: 'usage: reticle try <url> [--persona <who>]' };
  return persona === undefined ? { url } : { url, persona };
}

const WORKS = new Set<string>([ScriptStatus.PASSED]);
const BROKEN = new Set<string>([ScriptStatus.FAILED]);

/** The summary, worst news last so it is the line a reader's eye lands on. Pure. */
export function summarizeTry(journeys: readonly TryJourney[]): string[] {
  // A branch whose condition did not hold was never a journey this app took.
  const tried = journeys.filter((j) => ScriptStatus.NOT_TAKEN !== j.status);
  const works = tried.filter((j) => WORKS.has(j.status)).length;
  const broken = tried.filter((j) => BROKEN.has(j.status)).length;
  const unproved = tried.length - works - broken;
  const head =
    `Tried ${String(tried.length)} journey${1 === tried.length ? '' : 's'}: ` +
    `${String(works)} work, ${String(broken)} broken` +
    (0 === unproved ? '' : `, ${String(unproved)} not proved`);
  return [
    head,
    ...tried.map((j) =>
      WORKS.has(j.status)
        ? `  ✓ works: ${j.title}`
        : BROKEN.has(j.status)
          ? `  ✗ broken: ${j.title}`
          : `  ? not proved (${j.status}): ${j.title}`,
    ),
  ];
}

export async function runTry(args: TryArgs, ports: TryPorts): Promise<number> {
  const cloud = await ports.linked();
  if (null === cloud) {
    ports.fail(MSG_SIGN_IN_FIRST);
    return EXIT_FAIL;
  }
  const grant = await ports.requestDrive(cloud);
  if (!grant.granted) {
    ports.fail(grant.message);
    if (grant.hint !== undefined) ports.fail(grant.hint);
    if (grant.needsCard) {
      const base = (await ports.dashboardUrl(cloud).catch(() => undefined)) ?? cloud.url;
      ports.fail(`Plans: ${planUrl(base)}`);
    }
    return EXIT_FAIL;
  }
  ports.out(`Driving ${args.url} — watch the window Reticle opens.`);
  const drive = await ports.drive({
    url: args.url,
    driveId: grant.driveId,
    ...(args.persona === undefined ? {} : { persona: args.persona }),
  });
  if (drive.error !== undefined) {
    ports.fail(drive.error);
    return EXIT_FAIL;
  }
  for (const line of summarizeTry(drive.journeys)) ports.out(line);
  // Saying "saved" over a sync that failed would be this command lying about its own work.
  if (await ports.sync(drive.runIds).catch(() => false)) {
    const dashboard = await ports.dashboardUrl(cloud).catch(() => undefined);
    // Each run on its own page when the dashboard is known; the dashboard itself otherwise.
    const lines =
      dashboard === undefined || 0 === drive.runIds.length
        ? [`Saved to your dashboard: ${dashboard ?? cloud.url}`]
        : drive.runIds.map((runId) => seeRunLine(dashboard, runId));
    for (const line of lines) ports.out(line);
  } else {
    ports.fail(
      'The run is kept on this machine; it could not be sent. Run `reticle sync` to retry.',
    );
  }
  return EXIT_OK;
}

const str = (value: unknown): string | undefined => ('string' === typeof value ? value : undefined);

/** The journeys out of an explore report, or one journey graded from the drive when unplanned. */
export function journeysOf(report: Record<string, unknown>, persona?: string): TryJourney[] {
  const listed = report['journeys'];
  if (Array.isArray(listed) && 0 < listed.length) {
    return listed.flatMap((item) => {
      const j = item as Record<string, unknown>;
      const title = str(j['title']);
      const status = str(j['status']);
      return title === undefined || status === undefined ? [] : [{ title, status }];
    });
  }
  // An unplanned drive is one journey, graded by the one rule every drive is: failed only when a
  // check came back no. A missed goal or undecided checks prove nothing either way.
  const checks = asRecord(report['checks']);
  const count = (key: string): number => ('number' === typeof checks[key] ? checks[key] : 0);
  const goalMet = report['goalMet'];
  const flow = driveFlowStatus({
    held: count('held'),
    failed: count('failed'),
    ...('boolean' === typeof goalMet ? { goalMet } : {}),
  });
  const status =
    RunFlowStatus.FAIL === flow
      ? ScriptStatus.FAILED
      : RunFlowStatus.PASS === flow
        ? ScriptStatus.PASSED
        : ScriptStatus.BLOCKED;
  return [{ title: persona ?? 'Autonomous drive', status }];
}

function tryPort(cwd: string): number {
  const fromEnv = Number(process.env[ReticleEnv.PORT]);
  if (Number.isInteger(fromEnv) && 0 < fromEnv) return fromEnv;
  return readProjectPort(cwd) ?? RETICLE_DEFAULT_PORT;
}

/** A daemon serving `port`: the one already there, or one started now. Undefined when ready. */
async function ensureTryDaemon(port: number): Promise<string | undefined> {
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (presenceIsUsable(presence)) return undefined;
  // A stranger on the port: a daemon spawned now could not bind, so say who holds it instead.
  if (PortPresence.FREE !== presence) return describePresence(presence, port);
  const script = process.argv[1];
  if (script === undefined) return 'Cannot locate the reticle daemon script.';
  spawnDaemon(process.execPath, script, [DAEMON_INNER_COMMAND, PORT_FLAG, String(port)], port);
  return (await waitForDaemonBind(port))
    ? undefined
    : `Could not start the Reticle daemon on port ${String(port)}.`;
}

/** The drive itself, through the daemon: a watched window, the zero-install reader, one explore. */
async function driveThroughDaemon(
  port: number,
  request: { url: string; driveId: string; persona?: string },
  /** Where the drive's run must land: the folder `try` waits on and pushes from. */
  reticleRoot: string,
): Promise<TryDrive> {
  const unavailable = await ensureTryDaemon(port);
  if (unavailable !== undefined) return { journeys: [], runIds: [], error: unavailable };
  const token = readOrCreatePairingTokenSync(defaultPairingTokenDir());
  const caller = await connectOverSse(endpointFor(port, token));
  try {
    // Headed whatever the daemon was started as: the point of `try` is watching it happen. An app
    // with no Reticle SDK gets one supplied by the lease.
    const opened = await acquireLease(caller, request.url, true, reticleRoot);
    if ('failed' in opened) return { journeys: [], runIds: [], error: opened.failed.join('\n') };
    try {
      const drove = await exploreToEnd(
        caller,
        {
          sessionId: opened.leased,
          driveId: request.driveId,
          maxSteps: TRY_MAX_STEPS,
          ...(request.persona === undefined ? {} : { persona: request.persona }),
        },
        TRY_BUDGET_MS,
      );
      const refusal = refusalText(drove);
      if (refusal !== undefined) return { journeys: [], runIds: [], error: refusal };
      const report = verdictOf(drove, 'stopReason') ?? {};
      const runIds = Array.isArray(report['runIds'])
        ? report['runIds'].filter((id): id is string => 'string' === typeof id)
        : [];
      const broke = str(report['error']);
      return {
        journeys: journeysOf(report, request.persona),
        runIds,
        ...(broke === undefined ? {} : { error: `The drive broke: ${broke}` }),
      };
    } finally {
      // Closing the tab is what ends the session, and the session's end is what writes the run.
      await releaseLease(caller, opened.leased);
    }
  } finally {
    await caller.close().catch(() => undefined);
  }
}

/** Wait, bounded, for the daemon to write the drive's runs; a run that never lands is not sent. */
async function waitForRuns(reticleRoot: string, runIds: readonly string[]): Promise<void> {
  const runsDir = join(reticleRoot, ReticleDir.RUNS_SUBDIR);
  for (let waited = 0; waited < RUN_WRITE_WAIT_MS; waited += RUN_WRITE_POLL_MS) {
    if (runIds.every((id) => existsSync(join(runsDir, `${id}.json`)))) return;
    await new Promise((resolve) => setTimeout(resolve, RUN_WRITE_POLL_MS));
  }
}

/** What `try` borrows from the cloud commands, passed in so neither module imports the other. */
export interface TryCloud {
  push: () => Promise<number>;
  dashboardUrl: (cloud: CloudConfig) => Promise<string | undefined>;
}

/** `reticle try`, wired to this machine. Returns the exit code. */
export async function cmdTry(argv: readonly string[], cloudCommands: TryCloud): Promise<number> {
  const parsed = parseTryArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_FAIL;
  }
  const cwd = process.cwd();
  // The project this folder belongs to, else this folder: the lease writes the run here, and this is
  // where try waits for it and pushes it from — wherever the daemon happened to be started.
  const reticleRoot = callerArtifactRoot(cwd) ?? join(cwd, ReticleDir.ROOT);
  const port = tryPort(cwd);
  return runTry(parsed, {
    linked: linkedCloudPort(createNodeFileSystem(), reticleRoot, homedir(), process.env),
    requestDrive: (cloud) => requestFreeDrive(cloud, FreeDriveKind.TRY),
    drive: (request) => driveThroughDaemon(port, request, reticleRoot),
    sync: async (runIds) => {
      await waitForRuns(reticleRoot, runIds);
      return EXIT_OK === (await cloudCommands.push());
    },
    dashboardUrl: cloudCommands.dashboardUrl,
    out: (line) => process.stdout.write(`${line}\n`),
    fail: (line) => process.stderr.write(`${line}\n`),
  });
}

// ── how `init` ends ───────────────────────────────────────────────────────────────────────
/**
 * How `init` ends once the connection is proved: what Reticle sees of the app, what it is missing,
 * and the prompt that hands the rest to the coding agent, which proves the first flow. `init` never
 * drives: the Harness is opt-in and unlocks at a coverage score (core's `instrumentation-coverage.ts`), and a
 * freshly wired app is rarely there yet.
 *
 * Read from the daemon's `/status`, the same coverage `doctor` prints, so the two never disagree.
 */

/** What a project that is not linked is told, once, at the end. */
export const UNLINKED_PITCH = [
  'Results stay on this machine. `reticle connect` saves them to your dashboard and lets Reticle',
  'Harness test the whole app: a new account gets 10 free credits.',
];

/** Prove one flow with the coding agent: the line every ending names. */
export const msgProveOneFlow = (url: string): string =>
  `Then ask your coding agent: "Use Reticle to prove one flow in ${url}: drive it, and end with ` +
  'reticle_act_and_wait and an until on the last step."';

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const name: unknown =
          'object' === typeof item && null !== item
            ? (item as Record<string, unknown>)['capability']
            : item;
        return 'string' === typeof name ? [name] : [];
      })
    : [];

/**
 * The closing lines for one tab's coverage, as `/status` reports it: the score, what is missing, the
 * Harness gate in its own sentence, and the prompt for the coding agent. Pure.
 */
export function initCoverageLines(tab: Record<string, unknown> | undefined, url: string): string[] {
  const gate = asRecord(tab?.['harnessGate']);
  const percent = gate['percent'];
  if (tab === undefined || 'number' !== typeof percent)
    return [
      'Instrumentation is measured on an open tab of the app: run `reticle doctor` with it open.',
      msgProveOneFlow(url),
    ];
  const unseen = [...names(tab['missing']), ...names(tab['notSeenYet'])];
  const reason = gate['reason'];
  const prompt = tab['prompt'];
  return [
    `Instrumentation: ${String(percent)}%` +
      (0 === unseen.length ? '' : ` — missing: ${unseen.join(', ')}`),
    'string' === typeof reason
      ? reason
      : `Harness can be switched on: it is off until you switch it on in the HUD's Settings.`,
    ...('string' === typeof prompt
      ? [
          'Paste this into your coding agent; it closes the gaps and proves the first flow:',
          ...prompt.split('\n').map((line) => `  ${line}`),
        ]
      : [msgProveOneFlow(url)]),
  ];
}

/** The project's own `.reticle`, where the drive's flow and run land and where its link lives. */
const projectRoot = (appDir: string): string =>
  callerArtifactRoot(appDir) ?? join(appDir, ReticleDir.ROOT);

/**
 * This project's runs and flows that will never reach the dashboard as things stand, one line each:
 * not linked, no key for its host, flow sync off, or refused. A linked root's pending runs are left
 * out, because the daemon sends them within seconds and saying so would be noise.
 */
export async function strandedWorkLines(appDir: string): Promise<string[]> {
  const fs = createNodeFileSystem();
  const cloud = () => resolveProjectCloud(fs, projectRoot(appDir), homedir(), process.env);
  const roots = await unsyncedRoots(
    [projectRoot(appDir)],
    async () => {
      const c = await cloud();
      return null !== c.config && null !== c.projectId;
    },
    async () => (await cloud()).policy.flows,
  );
  return roots
    .filter((entry) => !entry.linked || 0 < entry.flows)
    .map((entry) => `⚠ ${describeUnsynced(entry, appDir)}`);
}

/** What `init` hands its ending, once the connection is proved. */
export interface FirstFlowContext {
  appDir: string;
  bridgePort: number;
  pairingToken?: string | undefined;
  url: string;
  sessionId: string;
  /** The proof came from a Reticle-owned browser, now closed: its own tab cannot be measured. */
  leased: boolean;
  openBrowser: boolean;
  /** False for `--no-first-run`: connect, and say nothing more. */
  firstRun: boolean;
  json: boolean;
}

/** The tab `init` proved, out of `/status`: by session, else the only one on the same url. */
function tabIn(
  status: unknown,
  sessionId: string,
  url: string,
): Record<string, unknown> | undefined {
  const list = asRecord(status)['coverage'];
  if (!Array.isArray(list)) return undefined;
  const tabs = list.map((entry: unknown) => asRecord(entry));
  return (
    tabs.find((tab) => sessionId === tab['sessionId']) ??
    tabs.find((tab) => 'string' === typeof tab['url'] && tab['url'].startsWith(url))
  );
}

/**
 * How `init` ends: the coverage score, the gaps and the agent prompt, the pitch when the project is
 * not linked, then what will never reach the dashboard. Nothing is driven. Never throws.
 */
export async function initFirstFlow(
  ctx: FirstFlowContext,
  say: (line: string) => void,
): Promise<{ flowSaved: boolean }> {
  if (ctx.firstRun) {
    // A leased proof's tab has closed; another open tab of the same app still answers for it.
    const status = await fetchStatus(ctx.bridgePort).catch(() => undefined);
    say('');
    for (const line of initCoverageLines(tabIn(status, ctx.sessionId, ctx.url), ctx.url)) say(line);
    const linked = linkedCloudPort(
      createNodeFileSystem(),
      projectRoot(ctx.appDir),
      homedir(),
      process.env,
    );
    if (null === (await linked().catch(() => null))) for (const line of UNLINKED_PITCH) say(line);
  }
  for (const line of await strandedWorkLines(ctx.appDir).catch(() => [])) say(line);
  return { flowSaved: false };
}

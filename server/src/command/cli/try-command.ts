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
import { headlessByDefault } from '@/command/cli/daemon-start-options.js';
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
import { cutOffReason } from '@/surface/tools/harness-explore.js';

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

// ── `init`'s first flow ───────────────────────────────────────────────────────────────────────
/**
 * The first flow: what `init` does once the connection is proved. Here beside `try` because it is
 * the same thing — one Harness drive on the platform's grant, summarised the same way — run in the
 * tab `init` just proved instead of one Reticle opens.
 *
 * Getting started has three stages, and onboarding used to hand the third to the reader as a
 * numbered list. With a linked project the Harness drives one flow itself, in the tab the person is
 * already watching, and saves it, so the first thing on the dashboard's Flows page comes out of
 * `init` rather than out of somebody remembering to ask an agent. Without a link there is no model
 * to drive with: the Harness runs on the platform. Then the one next step is said, and nothing more.
 *
 * Every effect is a port, so each branch is tested without a daemon, a platform or a browser.
 */
/** Who the first drive is. The one journey every app has, whatever it is for. */
export const FIRST_FLOW_PERSONA =
  'a first-time visitor: do the main thing this page offers, and check that it worked';
/** Model turns in the first drive: enough for one journey, and a bound on what it costs. */
export const FIRST_FLOW_MAX_STEPS = 20;
/** The whole drive before `init` stops waiting for it. The drive itself keeps its own ceiling. */
export const FIRST_FLOW_BUDGET_MS = 180_000;

/** Why the first flow was not driven. Each is a run where a drive nobody asked for is wrong. */
export const FirstFlowSkip = {
  /** `--no-first-run`. */
  FLAG: 'flag',
  /** `--json`: an agent reads one object, and drives with its own tools. */
  JSON: 'json',
  /** `--no-open`: the person asked for no window, so there is no tab of theirs to drive in. */
  NO_OPEN: 'no-open',
  /** CI, or a box with no display: never a surprise drive, never a surprise bill. */
  HEADLESS: 'headless',
  /** The connect was proved in a Reticle-owned browser that has already closed. */
  LEASED: 'leased',
} as const;
export type FirstFlowSkip = (typeof FirstFlowSkip)[keyof typeof FirstFlowSkip];

export function firstFlowSkip(run: {
  firstRun: boolean;
  json: boolean;
  openBrowser: boolean;
  headless: boolean;
  leased: boolean;
}): FirstFlowSkip | undefined {
  if (!run.firstRun) return FirstFlowSkip.FLAG;
  if (run.json) return FirstFlowSkip.JSON;
  if (!run.openBrowser) return FirstFlowSkip.NO_OPEN;
  if (run.headless) return FirstFlowSkip.HEADLESS;
  if (run.leased) return FirstFlowSkip.LEASED;
  return undefined;
}

export interface FirstFlowRequest {
  sessionId: string;
  driveId: string;
  persona: string;
  maxSteps: number;
}

export interface FirstFlowPorts {
  /** The credential `reticle connect` filed for this project, or null when it is not linked. */
  linked: () => Promise<CloudConfig | null>;
  /** The platform's grant for one drive. */
  grant: (cloud: CloudConfig) => Promise<FreeDrive>;
  /** One explore through the daemon, polled to its end: the tool's raw result. */
  drive: (request: FirstFlowRequest) => Promise<unknown>;
  note: (line: string) => void;
}

export interface FirstFlowOutcome {
  readonly flowSaved: boolean;
}

/**
 * What to do next when `init` did not drive: the agent route, which needs nothing, and the link that
 * lets Reticle drive it. Printed on every run that ended without a first flow.
 */
export function proveOneFlowLines(url: string): string[] {
  return [
    'Next, prove one flow:',
    `  1. Ask your coding agent: "Use Reticle to prove one flow in ${url}: drive it, and end ` +
      'with reticle_act_and_wait and an until on the last step." Only reticle_act_and_wait and ' +
      'reticle_assert produce a verdict.',
    '  2. Or let Reticle drive it: run `reticle connect` (free, no card), then re-run ' +
      '`reticle init` or press Run Harness in the HUD. The Harness runs on the Reticle platform, ' +
      'so it needs a linked project.',
  ];
}

const NOT_SAVED: FirstFlowOutcome = { flowSaved: false };

/**
 * The drive's verdict in one line, graded by the rule every drive is: failed only when a check came
 * back no, proved only when one held and none failed. A goal the model did not reach proves nothing
 * either way, so it is "not proved", never "broken".
 */
function firstFlowVerdict(report: Record<string, unknown>): string {
  const checks = asRecord(report['checks']);
  const count = (key: string): number => ('number' === typeof checks[key] ? checks[key] : 0);
  const goalMet = report['goalMet'];
  const status = driveFlowStatus({
    held: count('held'),
    failed: count('failed'),
    ...('boolean' === typeof goalMet ? { goalMet } : {}),
  });
  if (RunFlowStatus.PASS === status)
    return `✓ verified: yes — ${String(count('held'))} check(s) held.`;
  if (RunFlowStatus.FAIL === status)
    return `✗ verified: no — ${String(count('failed'))} check(s) failed. That is the app, not the check.`;
  const account = report['driverAccount'];
  return (
    '? not proved — the drive decided no check, so it says nothing either way about the app.' +
    ('string' === typeof account && 0 < account.length ? `\n  ${account}` : '')
  );
}

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => 'string' === typeof v) : [];

export async function runFirstFlow(
  sessionId: string,
  url: string,
  ports: FirstFlowPorts,
): Promise<FirstFlowOutcome> {
  const say = ports.note;
  say('');
  const cloud = await ports.linked().catch(() => null);
  if (null === cloud) {
    say('No first flow yet: this project is not linked, so there is no model to drive it with.');
    for (const line of proveOneFlowLines(url)) say(line);
    return NOT_SAVED;
  }
  const grant = await ports.grant(cloud);
  if (!grant.granted) {
    say(`No first flow yet: ${grant.message}`);
    if (grant.hint !== undefined) say(grant.hint);
    if (grant.needsCard) say(`Plans: ${planUrl(cloud.url)}`);
    for (const line of proveOneFlowLines(url).slice(0, 2)) say(line);
    return NOT_SAVED;
  }
  say(`Driving the first flow in your open tab, as ${FIRST_FLOW_PERSONA}. Watch it.`);
  let result: unknown;
  try {
    result = await ports.drive({
      sessionId,
      driveId: grant.driveId,
      persona: FIRST_FLOW_PERSONA,
      maxSteps: FIRST_FLOW_MAX_STEPS,
    });
  } catch (error) {
    say(`The first flow could not run: ${error instanceof Error ? error.message : String(error)}`);
    return NOT_SAVED;
  }
  const refusal = refusalText(result);
  if (refusal !== undefined) {
    say(`The first flow did not run: ${refusal}`);
    return NOT_SAVED;
  }
  const report = verdictOf(result, 'savedFlows') ?? {};
  const cut = cutOffReason(report);
  if (cut !== undefined) {
    say(`? not proved — ${cut}`);
    return NOT_SAVED;
  }
  say(firstFlowVerdict(report));
  const saved = [...names(report['savedFlows']), ...names(report['rewroteFlows'])];
  if (0 === saved.length) {
    const why = report['note'] ?? report['error'];
    say(
      'The drive saved no flow' +
        ('string' === typeof why ? `: ${why}` : '.') +
        ' Prove one with your coding agent instead.',
    );
    return NOT_SAVED;
  }
  say(
    `✓ Saved ${String(saved.length)} flow(s): ${saved.join(', ')}. Later runs replay ${
      1 === saved.length ? 'it' : 'them'
    } with no model in the loop; your tab stays open.`,
  );
  const empty = names(report['unverifiedFlows']).filter((name) => saved.includes(name));
  if (0 < empty.length) {
    say(
      `  ${empty.join(', ')} checks nothing yet: no step asserts a consequence, so a replay ` +
        'verifies nothing until one does. Ask your coding agent to prove the journey with ' +
        'reticle_act_and_wait and an until on its last step.',
    );
  }
  return { flowSaved: true };
}

/** The project's own `.reticle`, where the drive's flow and run land and where its link lives. */
const projectRoot = (appDir: string): string =>
  callerArtifactRoot(appDir) ?? join(appDir, ReticleDir.ROOT);

/** The ports, wired to this machine: the project's link, the platform's grant, the daemon's tools. */
export function nodeFirstFlowPorts(
  appDir: string,
  bridgePort: number,
  pairingToken: string | undefined,
  note: (line: string) => void,
): FirstFlowPorts {
  return {
    linked: linkedCloudPort(createNodeFileSystem(), projectRoot(appDir), homedir(), process.env),
    grant: (cloud) => requestFreeDrive(cloud, FreeDriveKind.EXPLORE),
    drive: async (request) => {
      const caller = await connectOverSse(endpointFor(bridgePort, pairingToken));
      try {
        return await exploreToEnd(caller, { ...request }, FIRST_FLOW_BUDGET_MS);
      } finally {
        await caller.close().catch(() => undefined);
      }
    },
    note,
  };
}

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

/** What `init` hands the first flow, once the connection is proved. */
export interface FirstFlowContext {
  appDir: string;
  bridgePort: number;
  pairingToken?: string | undefined;
  url: string;
  sessionId: string;
  /** The proof came from a Reticle-owned browser, now closed. */
  leased: boolean;
  openBrowser: boolean;
  /** False for `--no-first-run`. */
  firstRun: boolean;
  json: boolean;
}

/**
 * The first flow as `init` runs it: drive it when nothing says not to, else name the next step; then
 * say what this project holds that will never reach the dashboard. Never throws.
 */
export async function initFirstFlow(
  ctx: FirstFlowContext,
  say: (line: string) => void,
): Promise<{ flowSaved: boolean }> {
  const skip = firstFlowSkip({
    ...ctx,
    headless: headlessByDefault(process.env, process.platform),
  });
  let flowSaved = false;
  if (undefined === skip) {
    const ports = nodeFirstFlowPorts(ctx.appDir, ctx.bridgePort, ctx.pairingToken, say);
    flowSaved = (await runFirstFlow(ctx.sessionId, ctx.url, ports)).flowSaved;
  } else {
    say('');
    for (const line of proveOneFlowLines(ctx.url)) say(line);
  }
  for (const line of await strandedWorkLines(ctx.appDir).catch(() => [])) say(line);
  return { flowSaved };
}

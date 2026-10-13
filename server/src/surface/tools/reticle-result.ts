/**
 * The "Reticle result" block: what an agent pastes, verbatim, when it finishes verifying.
 *
 * Built by the server from facts it already holds, so the wording of a verdict is ours and not the
 * agent's: an agent asked to summarise an `unknown` tends to summarise it into a pass. Three verdict
 * words only — proved, not proved, failed — and an undecided check is never proved.
 *
 * The last line is the platform line, said once per result and never as a prompt: linked, where the
 * run is on the dashboard; not linked, what the platform adds and the one command. Nothing here is
 * measured that was not measured: a metric with no number is left out, never printed as a zero.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  JournalVerdictEffectSchema,
  ReticleDir,
  ReticleTool,
  RunFlowStatus,
  ScriptStatus,
  Verified,
  VerdictStatus,
  apiKeyFrom,
  type FlowReplayResult,
  type JournalAction,
  type SuiteVerdict,
} from '@reticlehq/core';
import { JourneyBy } from '@reticlehq/core/artifacts';
import { verdictLine } from '@/features/harness/drive-report.js';
import { mapReplayToFlowResult } from '@/judgement/runs/artifact/replay-mapping.js';
import { gapSummary } from '@/judgement/runs/artifact/gap-summary.js';
import { driveRunFrom, driveRunId, endAgentSession } from '@/judgement/runs/drive-run.js';
import { computeVerdict } from '@/judgement/runs/artifact/build-verification-run.js';
import { stepShotDir } from '@/memory/project/dir/reticle-dir.js';
import { TRIAL_OFFER } from '@reticlehq/core/hud';
import {
  KEY_REFUSED,
  dashboardRunUrl,
  keyRefusalAtLastSync,
  readDashboardUrl,
} from '@/memory/project/sync-status.js';
import type { TimedReplay } from '@/judgement/runs/verification-sync.js';
import { CONNECT } from './platform-moment.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import type { ToolDeps } from './tool-kit.js';

export const ResultWord = {
  PROVED: 'proved',
  NOT_PROVED: 'not proved',
  FAILED: 'failed',
} as const;
export type ResultWord = (typeof ResultWord)[keyof typeof ResultWord];

/** The output field every result that ends a verification carries. */
export const RESULT_FIELD = 'reticleResult';

/** Paths shown before the rest are counted: enough to open one, not enough to flood a reply. */
const EVIDENCE_SHOWN = 3;
const SEP = ' · ';
const HEAD = '**Reticle result: ';

const Said = {
  NOTHING_CHECKED: 'nothing was checked',
  CHECKS: 'Checks',
  COVERED: 'Covered',
  DID_NOT_HOLD: 'Did not hold',
  METRICS: 'Metrics',
  EVIDENCE: 'Evidence',
  RUN_LINK: 'Run on the dashboard',
  DASHBOARD: 'On the dashboard',
  SYNCED: 'Saved: the daemon syncs this run to the Reticle platform',
  PITCH:
    'Kept on this machine only. The Reticle platform adds run history, your team and Reticle Harness',
} as const;

export interface ResultFacts {
  yes: number;
  no: number;
  undecided: number;
  /** The journeys or flows the checks covered. */
  covered?: readonly string[];
  /** The journeys, flows or claims that did not hold. */
  failed?: readonly string[];
  flowsReplayed?: number;
  /** Harness journeys answered by replaying saved flows (no model), and driven by the model. */
  journeysReplayed?: number;
  journeysDriven?: number;
  wallMs?: number;
  screenshots?: readonly string[];
  /** From `platformLine`. */
  platform: string;
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${1 === n ? '' : 's'}`;

const seconds = (ms: number): string =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${String(Math.floor(ms / 60_000))}m ${String(Math.round((ms % 60_000) / 1000))}s`;

function headline(f: ResultFacts): string {
  const total = f.yes + f.no + f.undecided;
  if (0 < f.no)
    return `${HEAD}${ResultWord.FAILED}**${SEP}${String(f.no)} of ${plural(total, 'check')} did not hold`;
  if (0 === total) return `${HEAD}${ResultWord.NOT_PROVED}**${SEP}${Said.NOTHING_CHECKED}`;
  if (0 < f.undecided)
    return `${HEAD}${ResultWord.NOT_PROVED}**${SEP}${String(f.undecided)} of ${plural(total, 'check')} undecided`;
  return `${HEAD}${ResultWord.PROVED}**${SEP}${String(f.yes)} of ${plural(total, 'check')} held`;
}

/**
 * The evidence line. Screenshots filed under one run share one folder, so the folder is named once
 * with the count: three long paths cost a single replay more tokens than its verdict, and its answer
 * already lists each step's own path.
 */
function evidenceLine(shots: readonly string[]): string[] {
  if (0 === shots.length) return [];
  const dirs = new Set(shots.map((s) => dirname(s)));
  const [dir] = dirs;
  if (1 < shots.length && 1 === dirs.size && dir !== undefined)
    return [`- ${Said.EVIDENCE}: ${plural(shots.length, 'screenshot')} in ${dir}`];
  const more = shots.length - EVIDENCE_SHOWN;
  return [
    `- ${Said.EVIDENCE}: ${shots.slice(0, EVIDENCE_SHOWN).join(', ')}${0 < more ? ` (+${String(more)} more)` : ''}`,
  ];
}

/**
 * Each fact once. The headline carries the check count, so the metrics do not repeat it; with one
 * check the headline is the whole tally, so the per-word count line is left out.
 */
export function buildReticleResult(f: ResultFacts): string {
  const total = f.yes + f.no + f.undecided;
  const metrics = [
    ...(f.flowsReplayed === undefined ? [] : [`${plural(f.flowsReplayed, 'flow')} replayed`]),
    ...(f.journeysReplayed === undefined
      ? []
      : [`${plural(f.journeysReplayed, 'journey')} replayed`]),
    ...(f.journeysDriven === undefined ? [] : [`${plural(f.journeysDriven, 'journey')} driven`]),
    ...(f.wallMs === undefined ? [] : [seconds(f.wallMs)]),
  ];
  return [
    headline(f),
    ...(1 < total
      ? [
          `- ${Said.CHECKS}: ${String(f.yes)} yes${SEP}${String(f.no)} no${SEP}${String(f.undecided)} undecided`,
        ]
      : []),
    ...(0 < (f.covered?.length ?? 0) ? [`- ${Said.COVERED}: ${(f.covered ?? []).join(', ')}`] : []),
    ...(0 < (f.failed?.length ?? 0)
      ? [`- ${Said.DID_NOT_HOLD}: ${(f.failed ?? []).join(', ')}`]
      : []),
    ...(0 === metrics.length ? [] : [`- ${Said.METRICS}: ${metrics.join(SEP)}`]),
    ...evidenceLine(f.screenshots ?? []),
    f.platform,
  ].join('\n');
}

const WORD_FOR: Record<Verified, ResultWord> = {
  [Verified.YES]: ResultWord.PROVED,
  [Verified.NO]: ResultWord.FAILED,
  [Verified.UNKNOWN]: ResultWord.NOT_PROVED,
  [Verified.NO_FAULT]: ResultWord.NOT_PROVED,
};

/**
 * The same block under a verdict decided above the counts: `reticle_verify { change }` can turn a
 * green suite into `no` (a channel disagreed) or `unknown` (the flows do not cover the files).
 */
export function retitleResult(block: string, verified: Verified, because: string): string {
  const [, ...rest] = block.split('\n');
  return [`${HEAD}${WORD_FOR[verified]}**${SEP}${because}`, ...rest].join('\n');
}

/** The platform line when the key was refused: one true sentence, and the fix. */
export const KEY_REFUSED_HEAD = 'Not on the platform: ';
const keyRefusedLine = (why: string): string =>
  `${KEY_REFUSED_HEAD}${why.replace(/\.$/, '')}. Mint a new key in Settings → API keys; the run is kept on this machine`;
/** The line for a key refused for no reason the platform named. */
export const KEY_REFUSED_LINE = keyRefusedLine(KEY_REFUSED);

/** The platform line: where the run lives when linked, what linking adds when not. One line. */
export function platformLine(
  root: string,
  env: Record<string, string | undefined>,
  runId?: string,
): string {
  // Before any link: a run the platform will refuse is not "saved" and not "on the dashboard".
  const refusal = keyRefusalAtLastSync(root);
  if (refusal !== undefined) return `- ${keyRefusedLine(refusal)}`;
  const dashboard = readDashboardUrl(root);
  if (dashboard !== undefined)
    return runId === undefined
      ? `- ${Said.DASHBOARD}: ${dashboard}`
      : `- ${Said.RUN_LINK}: ${dashboardRunUrl(dashboard, runId)}`;
  if (existsSync(join(root, ReticleDir.CLOUD_LINK_FILE)) || apiKeyFrom(env) !== undefined)
    return `- ${Said.SYNCED}.`;
  return `- ${Said.PITCH} (${TRIAL_OFFER}): ${CONNECT}.`;
}

/** Screenshot paths a replay filed, in step order. */
const replayShots = (replay: FlowReplayResult): string[] =>
  replay.steps.flatMap((s) =>
    s.screenshot !== undefined && 'path' in s.screenshot ? [s.screenshot.path] : [],
  );

/**
 * The block for a replayed suite: the flows are the journeys, each flow's verdict one check, decided
 * as the run decides it (`mapReplayToFlowResult`): a green a channel contradicted is undecided, as
 * the suite's `unverifiable` status says, never held.
 */
export function suiteResult(
  root: string,
  verdict: SuiteVerdict,
  timed: readonly TimedReplay[],
  runId: string | undefined,
): string {
  const statuses = timed.map((t) => mapReplayToFlowResult(t.replay, t.durationMs).status);
  const count = (s: RunFlowStatus): number => statuses.filter((each) => s === each).length;
  return buildReticleResult({
    yes: count(RunFlowStatus.PASS),
    no: count(RunFlowStatus.FAIL),
    undecided: statuses.length - count(RunFlowStatus.PASS) - count(RunFlowStatus.FAIL),
    covered: timed.map((t) => t.replay.name),
    failed: verdict.failures.map((f) => f.flow),
    flowsReplayed: timed.length,
    wallMs: timed.reduce((sum, t) => sum + t.durationMs, 0),
    screenshots: timed.flatMap((t) => replayShots(t.replay)),
    platform: platformLine(root, process.env, runId),
  });
}

/**
 * `reticle_verify { change }`'s answer with the block on it. Its verdict is decided ABOVE the suite
 * (uncovered files, a disagreeing channel), so the suite's own block is retitled with that verdict
 * and moved to the top level: a nested block saying "proved" under an outer `no` is a false green.
 */
export function changeResult(root: string, out: unknown): unknown {
  if (null === out || 'object' !== typeof out) return out;
  const answer = out as Record<string, unknown>;
  const verified = answer['verified'];
  if (!Object.values(Verified).includes(verified as Verified)) return out;
  const suite = answer['suite'];
  const inner =
    null !== suite && 'object' === typeof suite
      ? (suite as Record<string, unknown>)[RESULT_FIELD]
      : undefined;
  const block =
    'string' === typeof inner
      ? inner
      : buildReticleResult({
          yes: 0,
          no: 0,
          undecided: 0,
          platform: platformLine(root, process.env),
        });
  const because = 'string' === typeof answer['because'] ? answer['because'] : '';
  return {
    ...answer,
    ...('string' === typeof inner
      ? {
          suite: Object.fromEntries(
            Object.entries(suite as Record<string, unknown>).filter(([k]) => RESULT_FIELD !== k),
          ),
        }
      : {}),
    [RESULT_FIELD]: retitleResult(block, verified as Verified, because),
  };
}

/** Claims named before the rest are counted: a session can hold dozens. */
const COVERED_SHOWN = 5;

const capped = (items: readonly string[], shown: number): string[] =>
  items.length <= shown
    ? [...items]
    : [...items.slice(0, shown), `(+${String(items.length - shown)} more)`];

/** The step screenshots a drive filed under its run, or none: evidence is listed, never assumed. */
function shotsOf(root: string, runId: string): string[] {
  try {
    const dir = stepShotDir(root, runId);
    return readdirSync(dir)
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * The block for one replayed flow: one check, decided as the synced run decides it — a pass whose
 * flow asserts nothing, or whose channels disagreed, is undecided, never held.
 */
export function replayResult(
  root: string,
  replay: FlowReplayResult,
  durationMs: number,
  runId: string | undefined,
): string {
  const status = mapReplayToFlowResult(replay, durationMs).status;
  const held = RunFlowStatus.PASS === status;
  const failed = RunFlowStatus.FAIL === status;
  return buildReticleResult({
    yes: held ? 1 : 0,
    no: failed ? 1 : 0,
    undecided: held || failed ? 0 : 1,
    covered: [replay.name],
    ...(failed ? { failed: [replay.name] } : {}),
    flowsReplayed: 1,
    wallMs: durationMs,
    screenshots: replayShots(replay),
    platform: platformLine(root, process.env, runId),
  });
}

/** What a Harness drive's answer says about itself, as the block reads it. */
export interface DriveFacts {
  checks: { held: number; failed: number; undecided: number };
  /** The end-state goals the Harness graded itself. */
  goals: readonly { verified: string }[];
  goalMet?: boolean;
  journeys?: readonly { title: string; status: string; by?: string }[];
  runIds?: readonly string[];
}

const MSG_GOAL_NOT_REACHED = 'the drive did not reach its goal';

/**
 * The block for a Harness drive: its checks and its graded goals are the checks; a plan's journeys
 * are what it covered, with how many were replayed and how many the model drove. Checks that held
 * over a goal the drive did not reach are not proved, as the answer's own `proved` says.
 */
export function exploreResult(root: string, drive: DriveFacts): string {
  // The checks, counted once and as the run's own summary counts them: the graded goals decide
  // `goalMet` (and the headline below) and were added on top, so one run read "2 of 2 check(s)
  // held" in its summary and "3 of 3" here.
  const yes = drive.checks.held;
  const no = drive.checks.failed;
  const undecided = drive.checks.undecided;
  const journeys = drive.journeys ?? [];
  const by = (b: JourneyBy): number => journeys.filter((j) => b === j.by).length;
  const answered = journeys.some((j) => j.by !== undefined);
  const block = buildReticleResult({
    yes,
    no,
    undecided,
    ...(0 === journeys.length
      ? {}
      : {
          covered: capped(
            journeys.map((j) => j.title),
            COVERED_SHOWN,
          ),
          failed: journeys.filter((j) => 'failed' === j.status).map((j) => j.title),
        }),
    ...(answered
      ? { journeysReplayed: by(JourneyBy.REPLAY), journeysDriven: by(JourneyBy.MODEL) }
      : {}),
    screenshots: (drive.runIds ?? []).flatMap((id) => shotsOf(root, id)),
    platform: platformLine(root, process.env, drive.runIds?.[0]),
  });
  // A plan's verdict is its journeys' (the same line the run ends on), never a count beside it.
  if (0 < journeys.length) {
    const line = verdictLine(drive.checks, drive.goalMet, journeys);
    const word = line.startsWith(PROVED_LINE)
      ? Verified.YES
      : journeys.some((j) => ScriptStatus.FAILED === j.status)
        ? Verified.NO
        : Verified.UNKNOWN;
    return WORD_FOR[word] === headWord(block)
      ? block
      : retitleResult(block, word, (line.split(' — ')[1] ?? line).replace(/\.$/, ''));
  }
  return 0 === no && 0 === undecided && 0 < yes && false === drive.goalMet
    ? retitleResult(block, Verified.UNKNOWN, MSG_GOAL_NOT_REACHED)
    : block;
}

const PROVED_LINE = 'PROVED';

/** The verdict word a block's headline carries. */
function headWord(block: string): string | undefined {
  return block.slice(HEAD.length).split('**')[0];
}

/**
 * The block for a session ending: every verdict the journal holds is one check. `no-fault` (nothing
 * declared) counts as undecided, never as held — a session that proved nothing must not read as one
 * that proved something.
 */
export function sessionResult(
  deps: ToolDeps,
  sessionId: string,
  actions: readonly JournalAction[],
  wallMs: number | undefined,
  runId: string = driveRunId(sessionId),
): string {
  const gap = gapSummary(actions);
  const held = [
    ...new Set(
      actions.flatMap((a) => {
        const v = JournalVerdictEffectSchema.safeParse(a.effect);
        return v.success && Verified.YES === v.data.verified ? [v.data.claim] : [];
      }),
    ),
  ];
  // The session's project, never wherever the daemon was launched.
  const root = sessionRoot(deps, sessionId);
  return buildReticleResult({
    yes: gap.held,
    no: gap.failed,
    undecided: gap.undecided + gap.nothingToProve,
    covered: capped(held, COVERED_SHOWN),
    failed: capped(
      gap.failures.map((f) => f.claim),
      COVERED_SHOWN,
    ),
    ...(wallMs === undefined ? {} : { wallMs }),
    screenshots: shotsOf(root, runId),
    platform: platformLine(root, process.env, 0 < gap.claims ? runId : undefined),
  });
}

/**
 * What an ending agent session reports: its own calls since its previous end in the tab, never the
 * Harness drives the tab also holds, and the run they are kept under.
 */
export function endedAgentSession(
  sessionId: string,
  actions: readonly JournalAction[],
  at: number | undefined,
  claim?: VerdictStatus,
): { actions: JournalAction[]; runId: string; wallMs?: number } {
  return endAgentSession(sessionId, actions, at, claim);
}

/**
 * The agent's own claim beside what grading the session's checks gave: the comparison a dashboard
 * makes, said where the agent can read it. The claim never becomes the verdict.
 */
export function claimAgainstGrade(
  claim: VerdictStatus,
  actions: readonly JournalAction[],
): { claimed: VerdictStatus; graded: VerdictStatus; agrees: boolean } {
  const run = driveRunFrom(actions, { runId: 'claim' });
  const status = run === undefined ? VerdictStatus.UNKNOWN : computeVerdict(run).status;
  // A failed check is a failed session, as its block's headline and the dashboard say: "partial"
  // beside "Reticle result: failed" was one answer with two verdicts.
  const failed = true === run?.checks.some((check) => Verified.NO === check.status);
  const graded = VerdictStatus.PARTIAL === status && failed ? VerdictStatus.FAIL : status;
  return { claimed: claim, graded, agrees: claim === graded };
}

/** The tools whose verdicts an agent session's block counts: each one is one of its checks. */
const SESSION_VERDICT_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.ACT_AND_WAIT,
  // `reticle_act { steps }` dispatches under ACT's name: a journey still grading is waited for too.
  ReticleTool.ACT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.ASSERT,
  ReticleTool.WAIT_FOR,
]);

/** Verdicts being decided right now. ponytail: daemon-wide, not per tab; an end waits for all. */
const inFlight = new Set<Promise<unknown>>();

/**
 * A verdict tool's call, remembered until it settles, so a session that ends meanwhile counts it.
 * An agent ended its session while a `reticle_assert { wait }` was still waiting: the end folded
 * first ("proved · 1 of 1"), a PASS on the dashboard, and the failure landed in the next run.
 */
export function trackVerdict<T>(tool: string, call: Promise<T>): Promise<T> {
  if (!SESSION_VERDICT_TOOLS.has(tool)) return call;
  const settled = call.then(
    () => undefined,
    () => undefined,
  );
  inFlight.add(settled);
  void settled.then(() => inFlight.delete(settled));
  return call;
}

/** Resolves once every verdict in flight now has been decided (and journaled). */
export async function verdictsSettled(): Promise<void> {
  await Promise.all([...inFlight]);
}

/** The block as a field, or no field: the block is advice, never the reason a result throws. */
export function resultField(build: () => string): Partial<Record<typeof RESULT_FIELD, string>> {
  try {
    return { [RESULT_FIELD]: build() };
  } catch {
    return {};
  }
}

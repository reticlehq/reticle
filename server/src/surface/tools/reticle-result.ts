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
import { join } from 'node:path';
import {
  JournalVerdictEffectSchema,
  ReticleDir,
  Verified,
  apiKeyFrom,
  type JournalAction,
  type SuiteVerdict,
} from '@reticlehq/core';
import { gapSummary } from '@/judgement/runs/artifact/gap-summary.js';
import { driveRunId } from '@/judgement/runs/drive-run.js';
import { stepShotDir } from '@/memory/project/dir/reticle-dir.js';
import { TRIAL_OFFER } from '@reticlehq/core/hud';
import { dashboardRunUrl, readDashboardUrl } from '@/memory/project/sync-status.js';
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

export function buildReticleResult(f: ResultFacts): string {
  const total = f.yes + f.no + f.undecided;
  const metrics = [
    plural(total, 'check'),
    ...(f.flowsReplayed === undefined ? [] : [`${plural(f.flowsReplayed, 'flow')} replayed`]),
    ...(f.wallMs === undefined ? [] : [seconds(f.wallMs)]),
  ];
  const shots = f.screenshots ?? [];
  const more = shots.length - EVIDENCE_SHOWN;
  return [
    headline(f),
    `- ${Said.CHECKS}: ${String(f.yes)} yes${SEP}${String(f.no)} no${SEP}${String(f.undecided)} undecided`,
    ...(0 < (f.covered?.length ?? 0) ? [`- ${Said.COVERED}: ${(f.covered ?? []).join(', ')}`] : []),
    ...(0 < (f.failed?.length ?? 0)
      ? [`- ${Said.DID_NOT_HOLD}: ${(f.failed ?? []).join(', ')}`]
      : []),
    `- ${Said.METRICS}: ${metrics.join(SEP)}`,
    ...(0 === shots.length
      ? []
      : [
          `- ${Said.EVIDENCE}: ${shots.slice(0, EVIDENCE_SHOWN).join(', ')}${0 < more ? ` (+${String(more)} more)` : ''}`,
        ]),
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

/** The platform line: where the run lives when linked, what linking adds when not. One line. */
export function platformLine(
  root: string,
  env: Record<string, string | undefined>,
  runId?: string,
): string {
  const dashboard = readDashboardUrl(root);
  if (dashboard !== undefined)
    return runId === undefined
      ? `- ${Said.DASHBOARD}: ${dashboard}`
      : `- ${Said.RUN_LINK}: ${dashboardRunUrl(dashboard, runId)}`;
  if (existsSync(join(root, ReticleDir.CLOUD_LINK_FILE)) || apiKeyFrom(env) !== undefined)
    return `- ${Said.SYNCED}.`;
  return `- ${Said.PITCH} (${TRIAL_OFFER}): ${CONNECT}.`;
}

/** The block for a replayed suite: the flows are the journeys, each flow's verdict one check. */
export function suiteResult(
  root: string,
  verdict: SuiteVerdict,
  timed: readonly TimedReplay[],
  runId: string | undefined,
): string {
  return buildReticleResult({
    yes: verdict.passed,
    no: verdict.failed,
    // Unverifiable flows and contradicted greens: ran, and decided nothing.
    undecided: Math.max(0, verdict.total - verdict.passed - verdict.failed),
    covered: timed.map((t) => t.replay.name),
    failed: verdict.failures.map((f) => f.flow),
    flowsReplayed: timed.length,
    wallMs: timed.reduce((sum, t) => sum + t.durationMs, 0),
    screenshots: timed.flatMap((t) =>
      t.replay.steps.flatMap((s) =>
        s.screenshot !== undefined && 'path' in s.screenshot ? [s.screenshot.path] : [],
      ),
    ),
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
 * The block for a session ending: every verdict the journal holds is one check. `no-fault` (nothing
 * declared) counts as undecided, never as held — a session that proved nothing must not read as one
 * that proved something.
 */
export function sessionResult(
  deps: ToolDeps,
  sessionId: string,
  actions: readonly JournalAction[],
  wallMs: number | undefined,
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
  const runId = driveRunId(sessionId);
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

/** The block as a field, or no field: the block is advice, never the reason a result throws. */
export function resultField(build: () => string): Partial<Record<typeof RESULT_FIELD, string>> {
  try {
    return { [RESULT_FIELD]: build() };
  } catch {
    return {};
  }
}

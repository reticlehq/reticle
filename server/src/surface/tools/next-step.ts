import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { DRIVE_RECORD_SUFFIX } from '@/memory/project/dir/reticle-dir.js';

/**
 * The one thing the agent should do next, on the result of the call it just made.
 *
 * Every client reads tool results; few read a briefing twice, and none keep a skill in mind across a
 * long session. So what an agent must not forget (record what the user asked, hand the tab back,
 * notice when its runs are not reaching the platform, tell the user how to connect) is said where
 * the agent is already looking, one short line, on the moment it applies. It is placed first in the
 * result, because a model that truncates a long result keeps its beginning.
 *
 * The daemon syncs runs itself, whichever agent drove them; nothing here asks an agent to push.
 * It only says when the sync needs a person (a refusal, a failure, a project never connected).
 */

/** How long a declared request counts as "the current task". Matches the run store's window. */
const REQUEST_FRESH_MS = 6 * 60 * 60 * 1000;
/** A reminder that is not about a verdict is repeated at most this often, per project. */
const QUIET_CALLS = 10;
/** An unlinked project hears how to connect on every Nth verdict, the first included. */
const CONNECT_EVERY = 5;
/**
 * How often the agent is asked to record the request before the other lines get their turn. In
 * every recorded run the agent ignored it, and because it always won, no agent was ever told its
 * runs were not reaching the platform.
 */
const DECLARE_ASKS = 2;
/** A run file this much newer than the last push, and this old, was not sent. */
const UNSENT_AFTER_MS = 2 * 60 * 1000;

export const NextText = {
  DECLARE:
    'Record what the user asked, once per task, verbatim: reticle_run { tool: "reticle_intent", args: { action: "declare", request: "<their words>" } }. It travels with every run.',
  SYNC_PROBLEM: (why: string): string =>
    `Runs are not reaching the platform (${why}). reticle_run { tool: "reticle_project", args: { push: true } } retries and reports why.`,
  CONNECT:
    'These runs stay on this machine. To share them on the team dashboard, the user runs once: npx @reticlehq/server connect',
  FINISH_LINKED:
    'Done driving? reticle_session { action: "yield" } hands the tab back; this run syncs to the platform on its own.',
  FINISH: 'Done driving? reticle_session { action: "yield" } hands the tab back.',
  REPLAY: (flows: number): string =>
    `This app has ${String(flows)} saved flow(s). Replay them before driving anything by hand: reticle_verify { action: "flows" } re-verifies them with no model.`,
} as const;

interface RootState {
  calls: number;
  verdicts: number;
  lastQuietAt: number;
  declareAsks: number;
  /** Told about the saved flows already, which is said once per project. */
  replayTold: boolean;
}

const roots = new Map<string, RootState>();

/** Tests only. */
export function resetNextStep(): void {
  roots.clear();
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return 'object' === typeof parsed && null !== parsed
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Declared within the window, read from the file's own stamp (or its age when it has none). */
function requestDeclared(root: string, now: number): boolean {
  const path = join(root, ReticleDir.REQUEST_FILE);
  if (!existsSync(path)) return false;
  const at = readJson(path)?.['at'];
  const when = 'number' === typeof at ? at : statSync(path).mtimeMs;
  return now - when < REQUEST_FRESH_MS;
}

/** Run files written after the last push and old enough that a sync cycle should have sent them. */
function unsentRuns(root: string, lastPushAt: number, now: number): number {
  try {
    const dir = join(root, ReticleDir.RUNS_SUBDIR);
    return readdirSync(dir).filter((name) => {
      // A drive's own record is not a run and never syncs.
      if (name.endsWith(DRIVE_RECORD_SUFFIX)) return false;
      const at = statSync(join(dir, name)).mtimeMs;
      return at > lastPushAt + UNSENT_AFTER_MS && now - at > UNSENT_AFTER_MS;
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Why sync needs a person, from the sync's own bookkeeping; undefined when it is fine.
 *
 * Runs that were written and never sent count too. A project the sync loop never looked at has no
 * error and no refusal, which is how a whole day of runs stayed on one machine with every check
 * reporting fine.
 */
function syncProblem(root: string, now: number): string | undefined {
  const state = readJson(join(root, ReticleDir.CLOUD_STATE_FILE));
  const pushed = state?.['lastPushAt'];
  const unsent = unsentRuns(root, 'number' === typeof pushed ? pushed : 0, now);
  if (0 < unsent) return `${String(unsent)} run(s) written here were never sent`;
  if (state === undefined) return undefined;
  const error = state['lastError'];
  if ('string' === typeof error && 0 < error.length) return error.slice(0, 120);
  const refused = state['refusedRuns'];
  const count = 'object' === typeof refused && null !== refused ? Object.keys(refused).length : 0;
  return 0 < count ? `${String(count)} run(s) refused` : undefined;
}

export interface NextStepInput {
  tool: string;
  /** Whether this result carries a verdict. */
  verdict: boolean;
  root: string | undefined;
  now: number;
}

/** Saved flow files under `flows/`, one level of project folders deep. */
function savedFlows(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce(
      (n, entry) =>
        n +
        (entry.isDirectory()
          ? readdirSync(join(dir, entry.name)).filter((f) => f.endsWith('.json')).length
          : entry.name.endsWith('.json')
            ? 1
            : 0),
      0,
    );
  } catch {
    return 0;
  }
}

/** The line, or undefined when there is nothing the agent should be told right now. */
export function nextStep(input: NextStepInput): string | undefined {
  const { root } = input;
  if (root === undefined) return undefined;
  const state = roots.get(root) ?? {
    calls: 0,
    verdicts: 0,
    lastQuietAt: Number.NEGATIVE_INFINITY,
    declareAsks: 0,
    replayTold: false,
  };
  roots.set(root, state);
  state.calls += 1;
  if (input.verdict) state.verdicts += 1;
  const linked = existsSync(join(root, ReticleDir.CLOUD_LINK_FILE));
  // A key in the environment syncs too, so its runs not arriving is just as much a problem.
  const sends = linked || 0 < (process.env[ReticleEnv.API_KEY] ?? '').length;
  const quietDue = state.calls - state.lastQuietAt >= QUIET_CALLS;

  // Measured on a whole-app drive: an agent re-drove everything by hand while saved flows sat
  // unreplayed, though the skill says to replay first. Said on the first call, where it is in time.
  if (!state.replayTold && !input.tool.endsWith('verify')) {
    state.replayTold = true;
    const saved = savedFlows(join(root, ReticleDir.FLOWS_SUBDIR));
    if (0 < saved) return NextText.REPLAY(saved);
  }
  const problem = sends ? syncProblem(root, input.now) : undefined;
  if (problem !== undefined && (input.verdict || quietDue)) {
    state.lastQuietAt = state.calls;
    return NextText.SYNC_PROBLEM(problem);
  }
  // Not on the declare call itself, which is the answer to this line.
  if (
    !input.tool.endsWith('intent') &&
    state.declareAsks < DECLARE_ASKS &&
    !requestDeclared(root, input.now) &&
    (input.verdict || quietDue)
  ) {
    state.lastQuietAt = state.calls;
    state.declareAsks += 1;
    return NextText.DECLARE;
  }
  if (!input.verdict) return undefined;
  if (!sends && 1 === state.verdicts % CONNECT_EVERY) return NextText.CONNECT;
  return sends ? NextText.FINISH_LINKED : NextText.FINISH;
}

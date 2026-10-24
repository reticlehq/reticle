import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { keyRefusalAtLastSync } from '@/memory/project/sync-status.js';
import { join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { DRIVE_RECORD_SUFFIX } from '@/memory/project/dir/reticle-dir.js';
import { callingAttachId } from '@/hooks/coding-agents.js';
import { INIT_COMMAND } from '@/portal/session/no-session-next-action.js';

/**
 * The one thing the agent should do next, on the result of the call it just made.
 *
 * Every client reads tool results; few read a briefing twice, and none keep a skill in mind across a
 * long session. So what an agent must not forget (record what the user asked, hand the tab back,
 * notice when its runs are not reaching the platform) is said where
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
  FINISH_LINKED:
    'Done driving? reticle_session { action: "yield" } hands the tab back; this run syncs to the platform on its own.',
  FINISH: 'Done driving? reticle_session { action: "yield" } hands the tab back.',
  /**
   * The evidence of this app is landing outside any project, so nothing will send it. A second
   * checkout's runs and flows went to `~/.reticle/unmatched/<id>` and the agent was told nothing.
   */
  UNMATCHED: (root: string, contenders: readonly string[], serving?: string): string => {
    const app = serving === undefined ? "This app's" : `The app served from ${serving}: its`;
    const lead = `${app} runs and flows are going to ${root}, not your project, so they will not reach the dashboard: `;
    if (0 === contenders.length) {
      return `${lead}no folder on this machine declares its project. Run \`${INIT_COMMAND}\` in the app's folder.`;
    }
    // `reticle init` alone keeps the id already on disk, so it cannot separate a copy from its original.
    const copy = serving ?? 'the copy';
    return (
      `${lead}${String(contenders.length)} folders claim its project id (${contenders.join(', ')}). ` +
      'Serve the app from the checkout that owns the id, or give the copy its own id: ' +
      `\`cd ${copy} && ${INIT_COMMAND} --new-id\`. That rewrites only the copy's .reticle.json, so keep the change on the copy's branch.`
    );
  },
  REPLAY: (flows: number): string =>
    `This app has ${String(flows)} saved flow(s). Replay them before driving anything by hand: reticle_verify { action: "flows" } re-verifies them with no model.`,
} as const;

interface RootState {
  calls: number;
  lastQuietAt: number;
  declareAsks: number;
  /** Told about the saved flows already, which is said once per project. */
  replayTold: boolean;
  /** The unmatched evidence folder already named. */
  unmatchedTold?: string;
  /** When this agent session first called here: what it wrote since is its own work. */
  since: number;
  /**
   * The sync problem already said. One flow the platform refused was repeated on every answer for a
   * whole session; a problem is said once, and again only when it changes.
   */
  problemTold?: string;
}

/**
 * Keyed by the agent session AND the folder: what is "said once" is said once to each agent. The
 * daemon outlives agent sessions, and keyed by folder alone a fresh session in a second checkout
 * was diverted into ~/.reticle/unmatched with nothing said, because an earlier one had been told.
 */
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

/**
 * Run files THIS agent session wrote (at or after `since`) after the last push, and old enough that a
 * sync cycle should have sent them. Another session's are not this one's to be told about.
 */
function unsentRuns(root: string, lastPushAt: number, now: number, since: number): number {
  try {
    const dir = join(root, ReticleDir.RUNS_SUBDIR);
    return readdirSync(dir).filter((name) => {
      // A drive's own record is not a run and never syncs.
      if (name.endsWith(DRIVE_RECORD_SUFFIX)) return false;
      const at = statSync(join(dir, name)).mtimeMs;
      return at >= since && at > lastPushAt + UNSENT_AFTER_MS && now - at > UNSENT_AFTER_MS;
    }).length;
  } catch {
    return 0;
  }
}

/** Whether this agent session wrote a run or a flow here since it began. */
function wroteSince(root: string, since: number): boolean {
  for (const sub of [ReticleDir.RUNS_SUBDIR, ReticleDir.FLOWS_SUBDIR]) {
    try {
      const dir = join(root, sub);
      if (readdirSync(dir).some((name) => statSync(join(dir, name)).mtimeMs >= since)) return true;
    } catch {
      /* nothing written there */
    }
  }
  return false;
}

/**
 * Why sync needs a person, from the sync's own bookkeeping; undefined when it is fine.
 *
 * Runs that were written and never sent count too. A project the sync loop never looked at has no
 * error and no refusal, which is how a whole day of runs stayed on one machine with every check
 * reporting fine.
 */
function syncProblem(root: string, now: number, since: number): string | undefined {
  const state = readJson(join(root, ReticleDir.CLOUD_STATE_FILE));
  const pushed = state?.['lastPushAt'];
  const unsent = unsentRuns(root, 'number' === typeof pushed ? pushed : 0, now, since);
  if (0 < unsent) return `${String(unsent)} run(s) written here were never sent`;
  if (state === undefined) return undefined;
  const error = state['lastError'];
  // A refused key read as the platform's "valid API key required" to a member removed from the
  // workspace, whose key was set: it was refused, which is what they have to act on — and it holds
  // back this session's work too, so it is said whoever wrote what.
  const refusal = keyRefusalAtLastSync(root);
  if (refusal !== undefined) return refusal;
  // Anything else the project's sync reports is said to a session whose own work it holds back: a
  // flow another session saved was named on every result of one that had written nothing.
  if (!wroteSince(root, since)) return undefined;
  if ('string' === typeof error && 0 < error.length) return error.slice(0, 120);
  const refused = state['refusedRuns'];
  const count = 'object' === typeof refused && null !== refused ? Object.keys(refused).length : 0;
  return 0 < count ? `${String(count)} run(s) refused` : undefined;
}

export interface NextStepInput {
  tool: string;
  /** Where this app's evidence goes when no project claims it, and the folders that compete for it. */
  unmatched?: { root: string; contenders: readonly string[]; serving?: string } | undefined;
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
  const key = `${callingAttachId() ?? ''}\u0000${root}`;
  const state = roots.get(key) ?? {
    calls: 0,
    lastQuietAt: Number.NEGATIVE_INFINITY,
    declareAsks: 0,
    replayTold: false,
    since: input.now,
  };
  roots.set(key, state);
  state.calls += 1;
  const linked = existsSync(join(root, ReticleDir.CLOUD_LINK_FILE));
  // A key in the environment syncs too, so its runs not arriving is just as much a problem.
  const sends = linked || 0 < (process.env[ReticleEnv.API_KEY] ?? '').length;
  const quietDue = state.calls - state.lastQuietAt >= QUIET_CALLS;

  // Before anything else, once per folder: everything else said here assumes the work is landing
  // in the project.
  const unmatched = input.unmatched;
  if (unmatched !== undefined && unmatched.root !== state.unmatchedTold) {
    state.unmatchedTold = unmatched.root;
    return NextText.UNMATCHED(unmatched.root, unmatched.contenders, unmatched.serving);
  }
  // Measured on a whole-app drive: an agent re-drove everything by hand while saved flows sat
  // unreplayed, though the skill says to replay first. Said on the first call, where it is in time.
  if (!state.replayTold && !input.tool.endsWith('verify')) {
    state.replayTold = true;
    const saved = savedFlows(join(root, ReticleDir.FLOWS_SUBDIR));
    if (0 < saved) return NextText.REPLAY(saved);
  }
  const problem = sends ? syncProblem(root, input.now, state.since) : undefined;
  if (problem !== undefined && problem !== state.problemTold && (input.verdict || quietDue)) {
    state.lastQuietAt = state.calls;
    state.problemTold = problem;
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
  // How to connect is the agent nudge's to say, once per session (`platform-moment.ts`).
  return sends ? NextText.FINISH_LINKED : NextText.FINISH;
}

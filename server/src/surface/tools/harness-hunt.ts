/**
 * The exploratory Harness around a drive: map the app first, hunt for the goal before grading it,
 * and compare the verdict with the coding agent's. The drive itself is the platform's; these are the
 * daemon's deterministic halves, shared by the planned and the unplanned path.
 */
import { dirname, join } from 'node:path';
import type { RunDisparity } from '@reticlehq/core';
import type { HarnessMap } from '@reticlehq/core/artifacts';
import {
  checkExpect,
  checkGoals,
  endGoalsOf,
  type Goal,
  type GoalCheck,
} from '@/features/harness/goals.js';
import type { ToolOutcome } from '@/features/harness/harness.js';
import { ReticleTool } from '@reticlehq/core';
import { searchForGoal } from '@/features/harness/explore/goal-search.js';
import {
  MAP_FRESH_MS,
  mergePages,
  pagesReadIn,
  parseMap,
  surveyApp,
} from '@/features/harness/explore/site-map.js';
import { agentVerdictsIn, disparityFor } from '@/features/harness/explore/disparity.js';
import type { Invoke } from '@/features/harness/explore/page-tree.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import {
  JournalActionSchema,
  ReticleDir,
  Verified,
  VerifiedReason,
  type JournalAction,
} from '@reticlehq/core';
import { isValidSessionId } from '@/memory/project/dir/reticle-dir.js';
import type { ToolDeps } from './tool-kit.js';

/**
 * Kept beside the plans: what this machine's drives learned about the app, local like them.
 * ponytail: a file in `plans/`, not a new `.reticle/` name, which would need the workspace tiers
 * and the ignore file to learn it; give it its own name if it ever needs to be shared.
 */
const HARNESS_MAP_FILE = 'harness-map.json';
/** Fewer pages than this and the kept map is not a map of the app. */
const MIN_MAPPED_PAGES = 2;
/** Sessions read from disk for the agent's verdicts: the recent past of one project, not its history. */
const MAX_JOURNALS_READ = 40;

function mapPath(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    return join(reticleDirPaths(sessionRoot(deps, sessionId)).plans, HARNESS_MAP_FILE);
  } catch {
    return undefined;
  }
}

async function readMap(deps: ToolDeps, path: string): Promise<HarnessMap | undefined> {
  try {
    return parseMap(await deps.fs.readFile(path));
  } catch {
    return undefined;
  }
}

async function writeMap(deps: ToolDeps, path: string, map: HarnessMap): Promise<void> {
  try {
    await deps.fs.mkdir(dirname(path));
    await deps.fs.writeFile(path, `${JSON.stringify(map, null, 2)}\n`);
  } catch {
    /* a map that cannot be kept is surveyed again next time */
  }
}

/** The pages a map knows, by route: what a drive is pointed at before it guesses. */
export const knownRoutes = (map: HarnessMap | undefined): string[] =>
  map === undefined ? [] : [...new Set(map.pages.map((page) => page.route))];

/** The app's map: the kept one while it is fresh, else a new survey merged over it. */
export async function siteMapFor(
  deps: ToolDeps,
  sessionId: string | undefined,
  invoke: Invoke,
): Promise<HarnessMap | undefined> {
  const path = mapPath(deps, sessionId);
  const kept = path === undefined ? undefined : await readMap(deps, path);
  // A map of one page is a survey that saw nothing (a menu was open): it is surveyed again.
  if (
    kept !== undefined &&
    MIN_MAPPED_PAGES <= kept.pages.length &&
    deps.now() - kept.surveyedAt < MAP_FRESH_MS
  )
    return kept;
  const surveyed = await surveyApp(invoke, deps.now);
  if (surveyed === undefined) return kept;
  const map = kept === undefined ? surveyed : mergePages(kept, surveyed.pages, surveyed.surveyedAt);
  if (path !== undefined) await writeMap(deps, path, map);
  return map;
}

/** What a drive read, folded into the kept map, so the map grows from use. */
export async function refreshMap(
  deps: ToolDeps,
  sessionId: string | undefined,
  map: HarnessMap | undefined,
  calls: readonly ToolOutcome[],
): Promise<void> {
  const path = mapPath(deps, sessionId);
  if (path === undefined || map === undefined) return;
  const read = pagesReadIn(calls, deps.now());
  if (0 < read.length) await writeMap(deps, path, mergePages(map, read));
}

/**
 * The decided verdicts the connected agent made on this app: in its live tabs, and in the journals
 * on disk of tabs that have closed. Persona 21's agent proved both goals on a tab that had closed by
 * the time the Harness graded, and the comparison was never made.
 */
async function agentVerdicts(deps: ToolDeps, sessionId: string | undefined) {
  let projectId: string | undefined;
  let own: string | undefined;
  try {
    const tab = deps.sessions.resolve(sessionId);
    projectId = tab.projectId;
    own = tab.id;
  } catch {
    return [];
  }
  const tabs = deps.sessions
    .all()
    .filter((s) => s.id === own || (projectId !== undefined && s.projectId === projectId));
  const live = await Promise.all(tabs.map((s) => s.readJournalActions().catch(() => [])));
  const onDisk = await journalsOnDisk(deps, sessionId, new Set(tabs.map((s) => s.id)));
  return agentVerdictsIn([...live.flat(), ...onDisk]);
}

/** A journal's lines as actions; a line that does not parse is left out, as the journal reader does. */
function actionsIn(text: string): JournalAction[] {
  return text.split('\n').flatMap((line) => {
    if (0 === line.trim().length) return [];
    try {
      const parsed = JournalActionSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** The actions of this project's sessions that are no longer live, from their journals. */
async function journalsOnDisk(
  deps: ToolDeps,
  sessionId: string | undefined,
  live: ReadonlySet<string>,
): Promise<JournalAction[]> {
  try {
    const root = sessionRoot(deps, sessionId);
    const ids = (await deps.fs.readdir(reticleDirPaths(root).sessions))
      .filter((id) => !live.has(id) && isValidSessionId(id))
      .slice(-MAX_JOURNALS_READ);
    const read = await Promise.all(
      ids.map((id) =>
        deps.fs
          .readFile(join(reticleDirPaths(root).sessions, id, ReticleDir.JOURNAL_ACTIONS_FILE))
          .then(actionsIn)
          .catch(() => [] as JournalAction[]),
      ),
    );
    return read.flat();
  } catch {
    return [];
  }
}

/** A drive's goals as graded, and how each compared with the agent's verdict. */
export interface Graded {
  goals: GoalCheck[];
  disparity: RunDisparity[];
  /** The navigations and clicks the hunt made: the Harness driving the app, said as such. */
  moved: ToolOutcome[];
}

/** What the hunt does to the app. Its asserts are not kept here: they would count as checks. */
const HUNT_MOVES: ReadonlySet<string> = new Set([ReticleTool.NAVIGATE, ReticleTool.ACT]);

/** The invoke, keeping each move it makes. */
function keepingMoves(invoke: Invoke, moved: ToolOutcome[]): Invoke {
  return async (name, args) => {
    const result = await invoke(name, args);
    if (HUNT_MOVES.has(name))
      moved.push({ id: `hunt-${String(moved.length + 1)}`, name, args, result, isError: false });
    return result;
  };
}

const RANK: Readonly<Record<string, number>> = { [Verified.YES]: 0, [Verified.NO]: 1 };

/**
 * One grade from each lane's: per goal, the lane that proved it, else one that disproved it on its
 * own page, else the first. A plan's lane that reached the end text proved it, whatever the others
 * (a known-defects lane, a lane on another page) saw.
 */
export function bestOfLanes(lanes: readonly Graded[]): Graded {
  const first = lanes[0] ?? { goals: [], disparity: [], moved: [] };
  const goals = first.goals
    .map((_, i) => {
      const all = lanes.flatMap((l) => (l.goals[i] === undefined ? [] : [l.goals[i]]));
      return (
        [...all].sort((a, b) => (RANK[a.verified] ?? 2) - (RANK[b.verified] ?? 2))[0] ??
        first.goals[i]
      );
    })
    .filter((g): g is GoalCheck => g !== undefined);
  const disparity = goals.flatMap((g) => {
    const lane = lanes.find((l) => l.goals.includes(g));
    return lane?.disparity.filter((d) => d.goal === g.text) ?? [];
  });
  return { goals, disparity, moved: lanes.flatMap((l) => l.moved) };
}

/**
 * The goals graded after a hunt for the journey's end. The end is the last goal the page did not
 * already show; when the hunt does not find it the check is undecided and says where it looked.
 */
export async function huntAndGrade(
  deps: ToolDeps,
  driving: Invoke,
  ask: {
    sessionId?: string | undefined;
    goals: readonly (string | Goal)[];
    expect?: Record<string, unknown> | undefined;
    opening?: string | undefined;
    journey?: string | undefined;
    map?: HarnessMap | undefined;
    /** Text the Harness wrote besides the journey: its plan's journeys, its flows' names. */
    own?: readonly string[] | undefined;
    /** The pages the drive reached (`pagesReached`), searched when the end is not where it stopped. */
    reached?: readonly string[] | undefined;
    /** The values the drive typed (`typedValues`): inputs, graded only when one is the end. */
    typed?: readonly string[] | undefined;
  },
): Promise<Graded> {
  const moved: ToolOutcome[] = [];
  const invoke = keepingMoves(driving, moved);
  // The journey names the plan and the flows this run saves: shown back on a page, it proves nothing.
  const own = [...(ask.own ?? []), ...(ask.journey === undefined ? [] : [ask.journey])];
  const goals = endGoalsOf(
    ask.goals.map((g) => ('string' === typeof g ? { text: g } : g)),
    ask.typed ?? [],
  );
  const end = goals
    .filter((g) => true !== g.absent && true !== ask.opening?.includes(g.text))
    .at(-1);
  const hunt = (goal: string) =>
    searchForGoal(invoke, {
      goal,
      ...(ask.journey === undefined ? {} : { journey: ask.journey }),
      ...(ask.map === undefined ? {} : { map: ask.map }),
      ...(ask.reached === undefined ? {} : { reached: ask.reached }),
      own,
    });
  const search = end === undefined ? undefined : await hunt(end.text);
  // The end not found anywhere: the tab is left where an earlier goal is, so that one is graded
  // where it shows rather than where the hunt gave up.
  if (search !== undefined && !search.found)
    for (const earlier of goals.filter((g) => g !== end && true !== g.absent).reverse())
      if ((await hunt(earlier.text)).found) break;
  const checks = (await checkGoals(invoke, goals, ask.opening, own)).map((c) =>
    end !== undefined &&
    c.text === end.text &&
    Verified.YES !== c.verified &&
    search !== undefined &&
    !search.found
      ? {
          ...c,
          reason: `${VerifiedReason.INCONCLUSIVE}: not found after searching ${search.searched.join(' → ')}`,
        }
      : c,
  );
  const agent = await agentVerdicts(deps, ask.sessionId);
  const disparity = checks.flatMap((c) => {
    const d = disparityFor(c, agent, c.text === end?.text ? search : undefined);
    return d === undefined ? [] : [d];
  });
  return {
    goals: [
      ...checks,
      ...(ask.expect === undefined ? [] : [await checkExpect(invoke, ask.expect)]),
    ],
    disparity,
    moved,
  };
}

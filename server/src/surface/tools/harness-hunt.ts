/**
 * The exploratory Harness around a drive: map the app first, hunt for the goal before grading it,
 * and compare the verdict with the coding agent's. The drive itself is the platform's; these are the
 * daemon's deterministic halves, shared by the planned and the unplanned path.
 */
import { dirname, join } from 'node:path';
import type { RunDisparity } from '@reticlehq/core';
import type { HarnessMap } from '@reticlehq/core/artifacts';
import { checkExpect, checkGoals, type Goal, type GoalCheck } from '@/features/harness/goals.js';
import type { ToolOutcome } from '@/features/harness/harness.js';
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
import { Verified, VerifiedReason } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';

/**
 * Kept beside the plans: what this machine's drives learned about the app, local like them.
 * ponytail: a file in `plans/`, not a new `.reticle/` name, which would need the workspace tiers
 * and the ignore file to learn it; give it its own name if it ever needs to be shared.
 */
const HARNESS_MAP_FILE = 'harness-map.json';

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

/** The app's map: the kept one while it is fresh, else a new survey merged over it. */
export async function siteMapFor(
  deps: ToolDeps,
  sessionId: string | undefined,
  invoke: Invoke,
): Promise<HarnessMap | undefined> {
  const path = mapPath(deps, sessionId);
  const kept = path === undefined ? undefined : await readMap(deps, path);
  if (kept !== undefined && deps.now() - kept.surveyedAt < MAP_FRESH_MS) return kept;
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

/** The decided verdicts the connected agent made in any live tab of this app. */
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
  const read = await Promise.all(tabs.map((s) => s.readJournalActions().catch(() => [])));
  return agentVerdictsIn(read.flat());
}

/** A drive's goals as graded, and how each compared with the agent's verdict. */
export interface Graded {
  goals: GoalCheck[];
  disparity: RunDisparity[];
}

const RANK: Readonly<Record<string, number>> = { [Verified.YES]: 0, [Verified.NO]: 1 };

/**
 * One grade from each lane's: per goal, the lane that proved it, else one that disproved it on its
 * own page, else the first. A plan's lane that reached the end text proved it, whatever the others
 * (a known-defects lane, a lane on another page) saw.
 */
export function bestOfLanes(lanes: readonly Graded[]): Graded {
  const first = lanes[0] ?? { goals: [], disparity: [] };
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
  return { goals, disparity };
}

/**
 * The goals graded after a hunt for the journey's end. The end is the last goal the page did not
 * already show; when the hunt does not find it the check is undecided and says where it looked.
 */
export async function huntAndGrade(
  deps: ToolDeps,
  invoke: Invoke,
  ask: {
    sessionId?: string | undefined;
    goals: readonly (string | Goal)[];
    expect?: Record<string, unknown> | undefined;
    opening?: string | undefined;
    journey?: string | undefined;
    map?: HarnessMap | undefined;
  },
): Promise<Graded> {
  const goals = ask.goals.map((g) => ('string' === typeof g ? { text: g } : g));
  const end = goals
    .filter((g) => true !== g.absent && true !== ask.opening?.includes(g.text))
    .at(-1);
  const search =
    end === undefined
      ? undefined
      : await searchForGoal(invoke, {
          goal: end.text,
          ...(ask.journey === undefined ? {} : { journey: ask.journey }),
          ...(ask.map === undefined ? {} : { map: ask.map }),
        });
  const checks = (await checkGoals(invoke, goals, ask.opening)).map((c) =>
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
  };
}

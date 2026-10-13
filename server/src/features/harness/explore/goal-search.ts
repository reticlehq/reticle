/**
 * Search before grading: a goal the drive did not end on is hunted for, the way a person would,
 * before anything is said about it.
 *
 * Every Harness miss in the persona drives had one shape: it graded where it stood. It judged an
 * Impact text on /runs, stopped one click short of "Team", read an empty search result as the
 * answer, called an opened menu a wrong guess, and walked past a goal it had reached. This hunt is
 * deterministic (no model) and bounded: from the page the drive ended on it tries the toggles and
 * tabs, then the controls the journey names (a menu that opens is followed into its items), then the
 * same page without its query, then the pages the map says show the goal, then the pages the drive
 * reached. It never fills a field
 * and never presses a name on the never-pressed list. Each place it looks is kept, so "not found"
 * says where it searched, and a goal it did not find is undecided, never a failure.
 */
import { ReticleTool } from '@reticlehq/core';
import type { HarnessMap } from '@reticlehq/core/artifacts';
import { lookFor } from '../goals.js';
import {
  journeyNames,
  namedControls,
  navLinks,
  overlayOpen,
  parseTree,
  readPage,
  toggles,
  withoutQuery,
  type Invoke,
  type TreeLine,
} from './page-tree.js';

/** Presses the hunt may spend: enough for a menu, its item and a tab, or a few toggles. */
export const SEARCH_MOVES = 10;
/** Shortest heading matched against the journey; shorter ones match by accident. */
const MIN_HEADING = 4;
/** How deep a chain of presses goes from one page: menu, item, tab. */
const MAX_DEPTH = 3;

export interface GoalSearch {
  found: boolean;
  /** Where it was found. */
  at?: string;
  /** Each place looked at and each press made, in order: `/runs`, `/runs: button "Team"`. */
  searched: string[];
  /** The last place looked at, when it was not found. */
  gaveUpAt?: string;
}

const label = (line: TreeLine): string => `${line.role} "${line.name}"`;

/** Hunt for `goal`, leaving the tab where it was found. */
export async function searchForGoal(
  invoke: Invoke,
  options: {
    goal: string;
    journey?: string;
    map?: HarnessMap;
    moves?: number;
    /** Text the Harness wrote itself: a match inside it is not the goal found. */
    own?: readonly string[];
    /** The pages the drive reached, in order: the goal may be on one it left. */
    reached?: readonly string[];
  },
): Promise<GoalSearch> {
  const { goal } = options;
  const journey = options.journey ?? '';
  const searched: string[] = [];
  const looked = new Set<string>();
  const pressed = new Set<string>();
  let left = options.moves ?? SEARCH_MOVES;
  let at: string | undefined;
  let reopened = false;

  /** Look here, then press what a person would press here, deeper while presses are left. */
  const explore = async (depth: number): Promise<boolean> => {
    const page = await readPage(invoke);
    if (page === undefined) return false;
    searched.push(page.route);
    looked.add(page.route);
    if (await lookFor(invoke, goal, options.own)) {
      at = page.route;
      return true;
    }
    if (MAX_DEPTH <= depth) return false;
    // Read again, settled by the look: a page read as it loaded offered none of its controls.
    const lines = parseTree((await readPage(invoke))?.tree ?? page.tree);
    // A menu or dialog the drive left open hides the page behind it: the live drive's hunt read the
    // workspace switcher and nothing else. Close it by reloading the page, once, and look again.
    if (0 === depth && !reopened && overlayOpen(lines)) {
      reopened = true;
      return (await go(page.route)) && explore(0);
    }
    // What the journey names on this page first ("press Run plan"), then the toggles, then the
    // named links that leave it: a switcher pressed as a toggle opened its menu over the plan page,
    // and the button the journey named was never pressed.
    const named = namedControls(lines, journey);
    const leaving = new Set<TreeLine>(navLinks(lines));
    const tries = [
      ...new Set(
        [
          ...named.filter((l) => !leaving.has(l)),
          ...toggles(lines),
          ...named.filter((l) => leaving.has(l)),
        ].map(label),
      ),
    ];
    const overlaid = overlayOpen(lines);
    for (const name of tries) {
      const key = `${page.route}: ${name}`;
      if (pressed.has(key)) continue;
      if (left <= 0) return false;
      // Found again on a fresh read: a ref does not survive the page coming back.
      const now = await readPage(invoke);
      const line = parseTree(now?.tree ?? '').find((l) => l.ref !== undefined && label(l) === name);
      if (line?.ref === undefined) continue;
      pressed.add(key);
      left -= 1;
      searched.push(key);
      try {
        await invoke(ReticleTool.ACT, { ref: line.ref, action: 'click' });
      } catch {
        continue;
      }
      if (await explore(depth + 1)) return true;
      // Back where it pressed from, with nothing it opened left over the page to hide the rest.
      const back = await readPage(invoke);
      const leftOpen = !overlaid && overlayOpen(parseTree(back?.tree ?? ''));
      if (back !== undefined && (back.route !== page.route || leftOpen)) await go(page.route);
    }
    return false;
  };

  const go = async (route: string): Promise<boolean> => {
    try {
      await invoke(ReticleTool.NAVIGATE, { url: route });
      return true;
    } catch {
      return false;
    }
  };

  const start = await readPage(invoke);
  if (await explore(0)) return { found: true, ...(at === undefined ? {} : { at }), searched };

  // A search or a filter that emptied the list, undone.
  const elsewhere = [
    ...(start === undefined || withoutQuery(start.route) === start.route
      ? []
      : [withoutQuery(start.route)]),
    ...mappedPagesFor(options.map, goal, journey),
    // Newest first: the drive's last page before it moved on is where a saved thing shows.
    ...[...(options.reached ?? [])].reverse(),
  ];
  for (const route of elsewhere) {
    if (looked.has(route) || left <= 0) continue;
    if (!(await go(route))) continue;
    if (await explore(1)) return { found: true, ...(at === undefined ? {} : { at }), searched };
  }
  const gaveUpAt = searched.at(-1);
  return { found: false, searched, ...(gaveUpAt === undefined ? {} : { gaveUpAt }) };
}

/** The mapped pages that show the goal, then the ones the journey names by heading. */
export function mappedPagesFor(
  map: HarnessMap | undefined,
  goal: string,
  journey: string,
): string[] {
  if (map === undefined) return [];
  const wanted = goal.toLowerCase();
  const said = journey.toLowerCase();
  const showing = map.pages.filter((p) => p.texts.some((t) => t.toLowerCase().includes(wanted)));
  // A page whose controls name what the journey asks for: Memory is a link on Flows.
  const leading = map.pages.filter((p) =>
    p.controls.some((c) => journeyNames(said, /"([^"]*)"/.exec(c)?.[1] ?? '')),
  );
  const named = map.pages.filter(
    (p) =>
      p.heading !== undefined &&
      MIN_HEADING <= p.heading.length &&
      said.includes(p.heading.toLowerCase()),
  );
  return [...new Set([...showing, ...leading, ...named].map((p) => p.route))];
}

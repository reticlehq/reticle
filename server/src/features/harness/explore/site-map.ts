/**
 * Map first: before the Harness pursues a goal, it surveys the app, cheaply and with no model.
 *
 * Persona drives missed goals that sat one page away: the drive committed to a route, a prediction
 * missed, and it graded where it stood. A person new to an app looks around first. The survey reads
 * the start page, presses each nav link and each toggle once (never a field, never a name on the
 * never-pressed list), reads where that leads, and goes back. The map is kept per app and refreshed
 * by every drive's own reads, so the survey runs again only when the map is old.
 */
import { PredicateKind, ReticleTool, SnapshotMode, asRecord } from '@reticlehq/core';
import {
  HarnessMapLimit,
  HarnessMapSchema,
  type HarnessMap,
  type HarnessMapPage,
} from '@reticlehq/core/artifacts';
import type { ToolOutcome } from '../harness.js';
import {
  navLinks,
  overlayOpen,
  parseTree,
  readPage,
  routeOf,
  textsOf,
  toggles,
  type Invoke,
  type PageRead,
  type TreeLine,
} from './page-tree.js';

/** Presses the survey may spend: a dashboard's navigation and its toggles, not its rows. */
export const SURVEY_PRESSES = 12;
/** A map older than this is surveyed again; a younger one is reused and refreshed from drives. */
export const MAP_FRESH_MS = 24 * 60 * 60 * 1000;
/** How long a page gets to settle after a press before it is read. */
const SETTLE_MS = 3000;

/**
 * Whether the app was surveyed for the run that started at `since` (or there is no map at all): a
 * run that reused a fresh map does not sweep the whole app again.
 */
export function surveyedSince(map: HarnessMap | undefined, since: number): boolean {
  return map === undefined || since <= map.surveyedAt;
}

/** One page read, as the map keeps it. */
export function pageFrom(read: PageRead, at: number, reachedBy?: string): HarnessMapPage {
  const lines = parseTree(read.tree);
  const heading = lines.find((l) => 'heading' === l.role && 0 < l.name.length)?.name;
  const clip = (t: string): string => t.slice(0, HarnessMapLimit.TEXT);
  return {
    route: clip(read.route),
    ...(heading === undefined ? {} : { heading: clip(heading) }),
    texts: textsOf(lines, HarnessMapLimit.TEXTS).map(clip),
    controls: lines
      .filter((l) => l.ref !== undefined && 0 < l.name.length)
      .slice(0, HarnessMapLimit.CONTROLS)
      .map((l) => clip(`${l.role} "${l.name}"`)),
    ...(reachedBy === undefined ? {} : { reachedBy: clip(reachedBy) }),
    at,
  };
}

/** Pages merged by route, the newest read winning, newest first, within the map's bound. */
export function mergePages(
  map: HarnessMap,
  pages: readonly HarnessMapPage[],
  surveyedAt = map.surveyedAt,
): HarnessMap {
  const byRoute = new Map(map.pages.map((p) => [p.route, p]));
  for (const page of pages) {
    const was = byRoute.get(page.route);
    if (was === undefined || was.at <= page.at) {
      const reachedBy = page.reachedBy ?? was?.reachedBy;
      byRoute.set(page.route, { ...page, ...(reachedBy === undefined ? {} : { reachedBy }) });
    }
  }
  const pagesOut = [...byRoute.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, HarnessMapLimit.PAGES);
  return { surveyedAt, pages: pagesOut };
}

/** The pages a drive read in full, for refreshing the map from what it saw. */
export function pagesReadIn(calls: readonly ToolOutcome[], at: number): HarnessMapPage[] {
  return calls.flatMap((call) => {
    // Only a full read of an unobstructed page: a quick read has no text, and a page behind an open
    // menu reads as the menu. Either one once replaced the survey's page and emptied the map.
    if (ReticleTool.SNAPSHOT !== call.name || call.isError) return [];
    if (SnapshotMode.FULL !== asRecord(call.args)['mode']) return [];
    const result = asRecord(call.result);
    const tree = result['tree'];
    const route = asRecord(result['status'])['route'];
    if ('string' !== typeof tree || 'string' !== typeof route) return [];
    if (overlayOpen(parseTree(tree))) return [];
    return [pageFrom({ tree, route: routeOf(route) }, at)];
  });
}

const label = (line: TreeLine): string => `${line.role} "${line.name}"`;

async function settle(invoke: Invoke): Promise<void> {
  try {
    await invoke(ReticleTool.WAIT_FOR, {
      predicate: { kind: PredicateKind.SETTLED },
      timeout_ms: SETTLE_MS,
    });
  } catch {
    /* a page that never settles is read as it stands */
  }
}

/**
 * Survey the app from where the tab stands, and leave the tab where it started. Every press is
 * found again by its name on a fresh read of the start page, since a ref does not survive a reload.
 */
export async function surveyApp(
  invoke: Invoke,
  now: () => number,
  presses = SURVEY_PRESSES,
): Promise<HarnessMap | undefined> {
  let start = await readPage(invoke);
  if (start === undefined) return undefined;
  // A menu left open hides the page behind it: reload it once before reading what it offers.
  if (overlayOpen(parseTree(start.tree))) {
    await invoke(ReticleTool.NAVIGATE, { url: start.route }).catch(() => undefined);
    start = (await readPage(invoke)) ?? start;
  }
  const pages: HarnessMapPage[] = [pageFrom(start, now())];
  const startLines = parseTree(start.tree);
  const targets = [...navLinks(startLines), ...toggles(startLines)]
    .map(label)
    .filter((name, i, all) => all.indexOf(name) === i)
    .slice(0, presses);
  for (const target of targets) {
    try {
      const here = await readPage(invoke);
      const line = parseTree(here?.tree ?? '').find(
        (l) => l.ref !== undefined && label(l) === target,
      );
      if (line?.ref === undefined) continue;
      await invoke(ReticleTool.ACT, { ref: line.ref, action: 'click' });
      await settle(invoke);
      const read = await readPage(invoke);
      if (read !== undefined) pages.push(pageFrom(read, now(), target));
      if (read !== undefined && read.route !== start.route)
        await invoke(ReticleTool.NAVIGATE, { url: start.route });
    } catch {
      /* a press that fails is a page the map does not have */
    }
  }
  return mergePages({ surveyedAt: now(), pages: [] }, pages, now());
}

/** The map from its file's text, or undefined when there is none or it does not parse. */
export function parseMap(text: string | undefined): HarnessMap | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = HarnessMapSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The map as the platform takes it: pages only, the fields its engine reads. */
export function mapForPlatform(map: HarnessMap): {
  pages: { route: string; heading?: string; texts: string[]; controls: string[] }[];
} {
  return {
    pages: map.pages.map((p) => ({
      route: p.route,
      ...(p.heading === undefined ? {} : { heading: p.heading }),
      texts: p.texts,
      controls: p.controls,
    })),
  };
}

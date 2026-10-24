/**
 * `reticle_map`: the app as the App Graph sees it, folded from what this project's sessions already
 * journaled. Which screens there are, which controls each has and which of them were pressed and
 * proven, the frontier (the important screens least proven), and the way to a screen as the anchors
 * to press. An agent told "test the whole app" starts where the map says, not at the front door.
 *
 * PULLED and folded on demand from the journals on disk, never a second store: the act path pays
 * nothing, and the answer cannot disagree with the ledger it was read from. The same fold
 * (`@reticlehq/core`'s `mapOfRun` and `mergeMap`) builds the cloud's map, so the two never disagree.
 */
import { z } from 'zod';
import {
  EventType,
  JournalActionSchema,
  MapEdgeKind,
  MapNodeKind,
  ReticleTool,
  asString,
  frontierLine,
  mapLine,
  mapOfRun,
  mergeMap,
  pathTo,
  type AppMap,
  type JournalAction,
  type ReticleEvent,
  type SessionId,
} from '@reticlehq/core';
import {
  isValidSessionId,
  journalActionsPath,
  journalEventsPath,
  reticleDirPaths,
} from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { sessionIdShape, type ToolDef, type ToolDeps } from './tool-kit.js';
import { journalSteps } from '@/judgement/app-graph/journal-steps.js';

/** Sessions folded: this project's recent past, as `harness-hunt` reads it, not its whole history. */
const MAX_SESSIONS = 20;
/** Screens listed, the most important first: a dashboard's screens, never its rows. */
const MAX_SCREENS = 40;

/** One session, as the fold reads it. */
export interface MapSession {
  id: string;
  actions: readonly JournalAction[];
  events: readonly ReticleEvent[];
}

/** One screen on the map, with how much of it was pressed and proven. */
export interface MapScreen {
  screen: string;
  actions: number;
  pressed: number;
  proven: number;
}

/** The project's sessions folded into one graph; undefined when none pressed anything. */
export function graphOfSessions(sessions: readonly MapSession[]): AppMap | undefined {
  let map: AppMap | undefined;
  for (const s of sessions) {
    const start = s.events.find((e) => EventType.ROUTE_CHANGE === e.type);
    const path = asString(start?.data['pathname']);
    map = mergeMap(map, mapOfRun(journalSteps(s.actions, s.events), s.events, path), s.id);
  }
  return map;
}

/** Each screen with its actions counted: what is there, what was pressed, what held. */
export function screensOf(map: AppMap): MapScreen[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return map.nodes
    .filter((n) => MapNodeKind.SCREEN === n.kind)
    .map((screen) => {
      const actions = map.edges
        .filter((e) => e.from === screen.id && MapEdgeKind.HAS === e.kind)
        .map((e) => byId.get(e.to))
        .filter((n) => n !== undefined);
      return {
        screen: screen.label,
        actions: actions.length,
        pressed: actions.filter((a) => 0 < (a.pressed ?? 0)).length,
        proven: actions.filter((a) => 0 < (a.proven ?? 0)).length,
      };
    })
    .sort((a, b) => b.actions - a.actions)
    .slice(0, MAX_SCREENS);
}

const linesOf = <T>(text: string, parse: (raw: unknown) => T | undefined): T[] =>
  text.split('\n').flatMap((line) => {
    if (0 === line.trim().length) return [];
    try {
      const value = parse(JSON.parse(line));
      return value === undefined ? [] : [value];
    } catch {
      return [];
    }
  });

const asEvent = (raw: unknown): ReticleEvent | undefined => {
  const e = raw as { t?: unknown; type?: unknown; data?: unknown } | null;
  return 'number' === typeof e?.t && 'string' === typeof e.type && 'object' === typeof e.data
    ? (raw as ReticleEvent)
    : undefined;
};

/** This project's sessions: its live tabs, then the journals on disk of tabs that have closed. */
async function sessionsFor(deps: ToolDeps, sessionId: string | undefined): Promise<MapSession[]> {
  let projectId: string | undefined;
  try {
    projectId = deps.sessions.resolve(sessionId).projectId;
  } catch {
    projectId = undefined;
  }
  const tabs = deps.sessions
    .all()
    .filter((s) => projectId === undefined || s.projectId === projectId);
  const live = await Promise.all(
    tabs.map(async (s) => ({
      id: s.id,
      actions: await s.readJournalActions().catch(() => []),
      events: await s.queryEvents({}).catch(() => []),
    })),
  );
  let onDisk: MapSession[] = [];
  try {
    const root = sessionRoot(deps, sessionId);
    const liveIds = new Set(tabs.map((s) => s.id));
    const ids = (await deps.fs.readdir(reticleDirPaths(root).sessions))
      .filter((id): id is SessionId => !liveIds.has(id) && isValidSessionId(id))
      .slice(-MAX_SESSIONS);
    onDisk = await Promise.all(
      ids.map(async (id) => ({
        id,
        actions: linesOf(
          await deps.fs.readFile(journalActionsPath(root, id)).catch(() => ''),
          (raw) => {
            const parsed = JournalActionSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
          },
        ),
        events: linesOf(
          await deps.fs.readFile(journalEventsPath(root, id)).catch(() => ''),
          asEvent,
        ),
      })),
    );
  } catch {
    onDisk = [];
  }
  return [...onDisk, ...live].slice(-MAX_SESSIONS);
}

export const MAP_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.MAP,
    description:
      "The app as Reticle has seen it, folded from this project's journaled sessions: `screens` (each route with how many controls it has, how many were pressed and how many proven), `frontier` (the most important screens least proven, where testing should go next) and `summary`. Pass `to` (a route) for `path`: the controls to press from `from` (default `/`) to reach it. Call it before testing a whole app or a feature, instead of starting from the front door again. It never drives the page; an empty answer means nothing has been pressed yet.",
    example: {},
    inputSchema: {
      to: z.string().optional().describe('A route to find the way to, e.g. `/settings/members`.'),
      from: z.string().optional().describe('Where the way starts; `/` when not given.'),
      ...sessionIdShape,
    },
    outputSchema: {
      summary: z
        .string()
        .optional()
        .describe('The map in one line: screens, actions, requests, things made.'),
      frontier: z.string().optional().describe('The most important screens least proven.'),
      screens: z
        .array(z.unknown())
        .optional()
        .describe('`{ screen, actions, pressed, proven }`, most actions first.'),
      path: z
        .array(z.unknown())
        .optional()
        .describe(
          'With `to`: the anchors to press, in order. Absent when no pressed way is known.',
        ),
    },
    handler: async (deps: ToolDeps, args) => {
      const map = graphOfSessions(await sessionsFor(deps, asString(args['sessionId'])));
      if (map === undefined) return { screens: [] };
      const to = asString(args['to']);
      const path = to === undefined ? undefined : pathTo(map, asString(args['from']) ?? '/', to);
      return {
        summary: mapLine(map),
        frontier: frontierLine(map),
        screens: screensOf(map),
        ...(path === undefined ? {} : { path }),
      };
    },
  },
];

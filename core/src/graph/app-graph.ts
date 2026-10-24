/**
 * The App Graph (what the cloud calls the App Map): the app as a graph, built from what each run recorded.
 *
 * Nodes are screens (route patterns), actions (what an act pressed, anchored the way a saved flow
 * anchors it), requests (method and route pattern) and the things writes made. Edges say a screen HAS
 * an action, an action LEADS TO a screen, SENDS a request and MAKES a thing. Everything here was
 * observed: the model's words never add a node. Ids collapse (`templatePath`), so a hundred
 * conversations are one screen and a row the drive created is a thing made, never a new screen: the
 * create-and-back-out loop a state graph otherwise falls into: each new row looks like a new screen,
 * so the drive keeps making rows and backing out.
 *
 * Pure: a run's acts and recording in, a run's map out; merged into the app's map across runs. One fold,
 * here in core, so the cloud verifier and the open-source daemon describe an app the same way: a fix to
 * how a screen is named lands in both. A run's acts arrive already parsed (`DrivenStep`): reading them
 * off a harness's tool calls needs the server package, so each caller does that and hands this the steps.
 */

import { EventType } from '@/wire/constants/event-types.js';
import { NetInitiator, isDevToolingUrl } from '@/wire/net.js';
import type { ReticleEvent } from '@/wire/messages.js';

/** One act a drive dispatched, anchored the way a flow anchors it, with its own window of events. */
export interface DrivenStep {
  anchor: Record<string, unknown>;
  since: number;
  window: readonly ReticleEvent[];
  /** Whether the consequence it declared held: absent when it declared none. */
  held?: boolean;
}

/** What a layout audit measured wrong on a screen (clipped text, overlap, contrast). */
export interface LayoutDefectSeen {
  kind: string;
  what: string;
  value: number;
  bound: number;
}

/** An app's identity: its origin, so every path of one deployment is one app. */
export function appIdentity(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Segments that identify one record rather than one kind of record: numeric, uuid-shaped, and a long
 * run of id characters (`chat_659b…`, `run_9_1792651401085`). Anything cleverer would start guessing.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const ID_RUN = /[0-9a-f]{12,}|\d{9,}/i;
const ID_PLACEHOLDER = ':id';

/** A path or URL as a route pattern: query dropped, origin dropped, record ids as `:id`. */
export function templatePath(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const path = withoutQuery.startsWith('http')
    ? (withoutQuery.split('/').slice(3).join('/') ?? '')
    : withoutQuery.replace(/^\/+/, '');
  const segments = path
    .split('/')
    .map((segment) =>
      NUMERIC.test(segment) || UUID_LIKE.test(segment) || ID_RUN.test(segment)
        ? ID_PLACEHOLDER
        : segment,
    );
  return `/${segments.join('/')}`;
}

const asString = (value: unknown): string | undefined =>
  'string' === typeof value ? value : undefined;

/** The route a route-change event names: the app's own pattern first, else the path it went to. */
export const routeOf = (data: Record<string, unknown>): string | undefined =>
  asString(data['pattern']) ??
  asString(data['pathname']) ??
  asString(data['to']) ??
  asString(data['path']);

export const MapNodeKind = {
  SCREEN: 'screen',
  ACTION: 'action',
  REQUEST: 'request',
  THING: 'thing',
} as const;
export type MapNodeKind = (typeof MapNodeKind)[keyof typeof MapNodeKind];

export const MapEdgeKind = {
  HAS: 'has',
  LEADS_TO: 'leads-to',
  SENDS: 'sends',
  MAKES: 'makes',
} as const;
export type MapEdgeKind = (typeof MapEdgeKind)[keyof typeof MapEdgeKind];

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  label: string;
  /** Runs that saw it. */
  seen: number;
  lastRun: string;
  /** For an action: runs in which a consequence it declared held, and in which one was refuted. */
  proven?: number;
  refuted?: number;
  /** For an action: runs in which it was pressed. An action only seen on its screen has none. */
  pressed?: number;
  /** For a pressed action: how to press it again, as the act that pressed it named the element. */
  anchor?: Anchor;
  /** For a screen: problems the latest run that reached it found there. Cleared by a clean one. */
  found?: number;
}

/** How an act names an element: by test id, or by role and accessible name. */
export interface Anchor {
  by: string;
  value: string;
  name?: string;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: MapEdgeKind;
  seen: number;
  lastRun: string;
}

export interface AppMap {
  nodes: readonly MapNode[];
  edges: readonly MapEdge[];
}

/** One run's map, before it is merged: what it saw, without counts. */
export interface RunMap {
  nodes: Map<
    string,
    {
      kind: MapNodeKind;
      label: string;
      held?: boolean;
      pressed?: true;
      anchor?: Anchor;
      found?: number;
    }
  >;
  edges: Map<string, { from: string; to: string; kind: MapEdgeKind }>;
}

const WRITES: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const APP_INITIATORS: ReadonlySet<string> = new Set([NetInitiator.FETCH, NetInitiator.XHR]);
const OK_MIN = 200;
const OK_MAX = 300;

const str = (value: unknown): string | undefined =>
  'string' === typeof value && '' !== value ? value : undefined;

/** A control's name with its counts taken out: "Open 2" and "Open 3" are one control. */
const normalName = (name: string): string => name.replace(/\d+/g, '#').trim();

/** A name this long is a row's data, not a control's label: a row is a thing, never an action. */
const ROW_NAME_CHARS = 60;

/** One control a look saw on a screen. */
export interface SeenControl {
  role: string;
  name: string;
  testid?: string;
  /** The component it renders in, when the engine names it: a data-named row's identity. */
  component?: string;
}

/** The controls each look saw, and on which screen. */
export interface SeenScreen {
  screen: string;
  controls: readonly SeenControl[];
  /** What the engine's layout audit measured wrong on it, when it was asked. */
  defects?: readonly LayoutDefectSeen[];
}

/**
 * What a person presses or fills. A list's options, a region or a heading is the screen's content: an
 * option without a test id is a row of data (a palette entry, a search result), so it stays out.
 */
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
]);

/** A snapshot line's start: `- <role> "`. */
const LINE_HEAD = /^\s*- (\S+) "/;
/** What ends a name, before the ref: `" (ref=`. */
const REF_OPEN = '" (ref=';
const REF_CLOSE = ')';
/** Line breaks other than `\n`. A name or a rest that holds one is not read. */
const LINE_BREAK = /[\r\u2028\u2029]/g;

/**
 * A snapshot line as role, name and the part after the ref: `- <role> "<name>" (ref=<ref>)<rest>`.
 * The name runs to the LAST `" (ref=` that a non-empty ref and a `)` follow.
 *
 * Read with `indexOf`, not one regular expression. The page writes this text, and a pattern with
 * two open-ended groups backtracks: its time grows with the square of the line length.
 */
const snapshotLine = (line: string): { role: string; name: string; rest: string } | undefined => {
  const head = LINE_HEAD.exec(line);
  if (null === head) {
    return undefined;
  }
  const start = head[0].length;
  const breaks = [...line.slice(start).matchAll(LINE_BREAK)].map((m) => start + m.index);
  const firstBreak = breaks[0] ?? line.length;
  const lastBreak = breaks[breaks.length - 1] ?? -1;
  const lastClose = line.lastIndexOf(REF_CLOSE);
  for (let at = line.lastIndexOf(REF_OPEN); start <= at; at = line.lastIndexOf(REF_OPEN, at - 1)) {
    const ref = at + REF_OPEN.length;
    if (ref < lastClose && REF_CLOSE !== line[ref]) {
      const close = line.indexOf(REF_CLOSE, ref);
      // A break may sit only inside the ref: never in the name, never in the rest.
      if (at <= firstBreak && lastBreak < close) {
        return { role: head[1] ?? '', name: line.slice(start, at), rest: line.slice(close + 1) };
      }
    }
  }
  return undefined;
};

/** The value of the first `[key=value]` with a non-empty value, read in one pass. */
const bracketValue = (text: string, key: string): string | undefined => {
  const open = `[${key}=`;
  for (let at = text.indexOf(open); -1 !== at; at = text.indexOf(open, at + 1)) {
    const start = at + open.length;
    const end = text.indexOf(']', start);
    if (-1 === end) {
      return undefined;
    }
    if (start < end) {
      return text.slice(start, end);
    }
  }
  return undefined;
};

/** The controls in a snapshot tree; rows (long, data-named, with no test id) left out. */
export const controlsOf = (tree: string): SeenControl[] =>
  tree.split('\n').flatMap((line) => {
    const parsed = snapshotLine(line);
    if (parsed === undefined) {
      return [];
    }
    const { role, name, rest } = parsed;
    const testid = bracketValue(rest, 'testid');
    const component = bracketValue(rest, 'component');
    if (testid === undefined && !CONTROL_ROLES.has(role)) {
      return [];
    }
    // A data-named row is kept only when its component names it; otherwise it is the row's data.
    if (testid === undefined && component === undefined && name.length > ROW_NAME_CHARS) {
      return [];
    }
    return [
      {
        role,
        name: normalName(name),
        ...(testid === undefined ? {} : { testid }),
        ...(component === undefined ? {} : { component }),
      },
    ];
  });

/** A seen control's identity on its screen, the same as the act that presses it would have. */
const controlKey = (c: SeenControl): string | undefined => {
  if (c.testid !== undefined) {
    return `testid=${c.testid}`;
  }
  if (c.component !== undefined && c.name.length > ROW_NAME_CHARS) {
    return `component=${c.component}`;
  }
  if ('' === c.name) {
    return undefined;
  }
  return `${c.role} "${c.name}"`;
};

/** An action's identity on its screen: the anchor a flow would use, never a ref. */
const anchorKey = (anchor: Record<string, unknown>): string | undefined => {
  const value = str(anchor['value']);
  if ('testid' === anchor['by'] && value !== undefined) {
    return `testid=${value}`;
  }
  const name = str(anchor['name']);
  const component = str(anchor['component']);
  // A row named by its data is one action of its component, as the look that saw it keyed it.
  if (component !== undefined && name !== undefined && name.length > ROW_NAME_CHARS) {
    return `component=${component}`;
  }
  if ('role' === anchor['by'] && value !== undefined && name !== undefined) {
    return `${value} "${normalName(name)}"`;
  }
  return component === undefined ? undefined : `component=${component}`;
};

/** What a write to a path made: its last segment that names a kind (`/v1/projects/:id/envs` → envs). */
const thingOf = (path: string): string | undefined =>
  path
    .split('/')
    .filter((segment) => '' !== segment && !segment.startsWith(':') && !/^v\d+$/.test(segment))
    .at(-1);

/**
 * The type a write's answer names, when it is JSON and says: Stripe's `object`, JSON:API's
 * `data.type`, or GraphQL's `__typename` a few levels down. Every GraphQL write goes to one path, so
 * the path alone would call every thing "graphql"; a REST answer that declares nothing keeps its path.
 */
const TYPENAME_DEPTH = 4;
const typenameOf = (body: unknown): string | undefined => {
  if ('string' !== typeof body || '' === body) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  // REST's own declarations: Stripe's `object`, JSON:API's `data.type`.
  const top = parsed as { object?: unknown; data?: { type?: unknown } } | null;
  if (null !== top && 'object' === typeof top) {
    if ('string' === typeof top.object && '' !== top.object) {
      return top.object;
    }
    if ('string' === typeof top.data?.type && '' !== top.data.type) {
      return top.data.type;
    }
  }
  if (!body.includes('__typename')) {
    return undefined;
  }
  const walk = (value: unknown, depth: number): string | undefined => {
    if (depth > TYPENAME_DEPTH || null === value || 'object' !== typeof value) {
      return undefined;
    }
    const own = (value as Record<string, unknown>)['__typename'];
    if ('string' === typeof own && '' !== own) {
      return own;
    }
    for (const child of Object.values(value)) {
      const found = walk(child, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(parsed, 0);
};

/** The map one run recorded. `start` is the route the run was loaded on. */
export function mapOfRun(
  steps: readonly DrivenStep[],
  events: readonly ReticleEvent[],
  start?: string,
  seen: readonly SeenScreen[] = [],
): RunMap {
  const nodes: RunMap['nodes'] = new Map();
  const edges: RunMap['edges'] = new Map();
  const node = (kind: MapNodeKind, label: string): string => {
    const id = `${kind} ${label}`;
    if (!nodes.has(id)) {
      nodes.set(id, { kind, label });
    }
    return id;
  };
  const edge = (from: string, to: string, kind: MapEdgeKind): void => {
    edges.set(`${from} ${kind} ${to}`, { from, to, kind });
  };
  const screenOf = (path: string): string => node(MapNodeKind.SCREEN, templatePath(path));
  const routes = events
    .filter((e) => EventType.ROUTE_CHANGE === e.type)
    .map((e) => ({ t: e.t, path: routeOf(e.data) }))
    .filter((r): r is { t: number; path: string } => r.path !== undefined);
  if (start !== undefined) {
    screenOf(start);
  }
  for (const r of routes) {
    screenOf(r.path);
  }
  // The screen an act was pressed on: the last route before its window opened.
  const on = (since: number): string | undefined => {
    const before = routes.filter((r) => r.t < since).at(-1)?.path ?? start;
    return before === undefined ? undefined : templatePath(before);
  };
  // A look records the address; the route change that reached it named the screen. Same screen.
  const named = new Map(
    events
      .filter((e) => EventType.ROUTE_CHANGE === e.type)
      .flatMap((e) => {
        const at = str(e.data['pathname']);
        const pattern = str(e.data['pattern']);
        return at === undefined || pattern === undefined ? [] : [[at, pattern] as const];
      }),
  );
  // What each look saw: every control a screen offers, pressed or not.
  for (const look of seen) {
    const screen = templatePath(named.get(look.screen) ?? look.screen);
    const at = node(MapNodeKind.SCREEN, screen);
    for (const control of look.controls) {
      const key = controlKey(control);
      if (key !== undefined) {
        edge(at, node(MapNodeKind.ACTION, `${screen} ${key}`), MapEdgeKind.HAS);
      }
    }
  }
  /**
   * Reads the app sent with nothing pressed (a poll, a badge refresh) are its background: one that
   * lands inside an action's window was not caused by it. Writes are always the action's.
   */
  const pressedWindows = new Set(steps.flatMap((s) => s.window));
  const background = new Set(
    events
      .filter((e) => EventType.NET_REQUEST === e.type && !pressedWindows.has(e))
      .map(
        (e) =>
          `${(str(e.data['method']) ?? 'GET').toUpperCase()} ${templatePath(str(e.data['url']) ?? '')}`,
      )
      .filter((key) => READS.has(key.split(' ')[0] ?? '')),
  );
  for (const s of steps) {
    const key = anchorKey(s.anchor);
    const screen = on(s.since);
    if (key === undefined || screen === undefined) {
      continue;
    }
    const action = node(MapNodeKind.ACTION, `${screen} ${key}`);
    // Proven if any press of it this run held; refuted only if one failed and none held.
    const seenAs = nodes.get(action);
    if (seenAs !== undefined) {
      seenAs.pressed = true;
      const by = str(s.anchor['by']);
      const value = str(s.anchor['value']);
      const name = str(s.anchor['name']);
      if (by !== undefined && value !== undefined) {
        seenAs.anchor = { by, value, ...(name === undefined ? {} : { name }) };
      }
    }
    if (seenAs !== undefined && s.held !== undefined && true !== seenAs.held) {
      seenAs.held = s.held;
    }
    edge(node(MapNodeKind.SCREEN, screen), action, MapEdgeKind.HAS);
    for (const e of s.window) {
      if (EventType.ROUTE_CHANGE === e.type) {
        const to = routeOf(e.data);
        if (to !== undefined) {
          edge(action, screenOf(to), MapEdgeKind.LEADS_TO);
        }
        continue;
      }
      if (EventType.NET_REQUEST !== e.type) {
        continue;
      }
      const url = str(e.data['url']) ?? '';
      if (isDevToolingUrl(url) || !APP_INITIATORS.has(str(e.data['initiator']) ?? '')) {
        continue;
      }
      const method = (str(e.data['method']) ?? 'GET').toUpperCase();
      const path = templatePath(url);
      if (background.has(`${method} ${path}`)) {
        continue;
      }
      edge(action, node(MapNodeKind.REQUEST, `${method} ${path}`), MapEdgeKind.SENDS);
      const status = 'number' === typeof e.data['status'] ? e.data['status'] : 0;
      const made = typenameOf(e.data['responseBody']) ?? thingOf(path);
      if (WRITES.has(method) && status >= OK_MIN && status < OK_MAX && made !== undefined) {
        edge(action, node(MapNodeKind.THING, made), MapEdgeKind.MAKES);
      }
    }
  }
  return { nodes, edges };
}

/** The app's map with one more run folded in: counts add up, nothing a run did not see is lost. */
export function mergeMap(map: AppMap | undefined, run: RunMap, runId: string): AppMap {
  const nodes = new Map((map?.nodes ?? []).map((n) => [n.id, { ...n }]));
  for (const [id, { held: verdict, pressed: wasPressed, anchor: pressedBy, ...n }] of run.nodes) {
    const held = nodes.get(id);
    const proven = (held?.proven ?? 0) + (true === verdict ? 1 : 0);
    const refuted = (held?.refuted ?? 0) + (false === verdict ? 1 : 0);
    const pressed = (held?.pressed ?? 0) + (true === wasPressed ? 1 : 0);
    nodes.set(id, {
      id,
      ...n,
      seen: (held?.seen ?? 0) + 1,
      lastRun: runId,
      ...(0 === proven ? {} : { proven }),
      ...(0 === refuted ? {} : { refuted }),
      ...(0 === pressed ? {} : { pressed }),
      // The latest way it was pressed, else the one it was pressed by before.
      ...((a) => (a === undefined ? {} : { anchor: a }))(pressedBy ?? held?.anchor),
    });
  }
  const key = (e: { from: string; kind: string; to: string }): string =>
    `${e.from} ${e.kind} ${e.to}`;
  const edges = new Map((map?.edges ?? []).map((e) => [key(e), { ...e }]));
  for (const e of run.edges.values()) {
    const held = edges.get(key(e));
    edges.set(key(e), { ...e, seen: (held?.seen ?? 0) + 1, lastRun: runId });
  }
  const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
  return {
    nodes: [...nodes.values()].sort(byId),
    edges: [...edges.values()].sort((a, b) => key(a).localeCompare(key(b))),
  };
}

/** What the map knows, in one line. */
export function mapLine(map: AppMap): string {
  const of = (kind: MapNodeKind) => map.nodes.filter((n) => kind === n.kind);
  const count = (n: number, one: string, many: string): string =>
    `${String(n)} ${1 === n ? one : many}`;
  const things = of(MapNodeKind.THING).map((n) => n.label);
  return `The map so far: ${count(of(MapNodeKind.SCREEN).length, 'screen', 'screens')}, ${count(
    of(MapNodeKind.ACTION).length,
    'action',
    'actions',
  )}, ${count(of(MapNodeKind.REQUEST).length, 'request', 'requests')}, ${count(
    things.length,
    'thing made',
    'things made',
  )}${0 === things.length ? '' : ` (${things.join(', ')})`}.`;
}

/** At most this many screens the frontier line names. */
const FRONTIER_NAMED = 6;

/**
 * The most important screens first, with how much of each is proven: where the next run should go.
 * Importance is read off the graph, never guessed: the actions that lead to a screen, and, twice over,
 * the kinds of thing its actions make (the work people come to do).
 */
export function frontierLine(map: AppMap): string {
  const plural = (n: number, one: string): string => `${String(n)} ${one}${1 === n ? '' : 's'}`;
  const screens = map.nodes
    .filter((n) => MapNodeKind.SCREEN === n.kind)
    .map((screen) => {
      const actions = map.edges
        .filter((e) => MapEdgeKind.HAS === e.kind && screen.id === e.from)
        .map((e) => e.to);
      const inbound = new Set(
        map.edges
          .filter((e) => MapEdgeKind.LEADS_TO === e.kind && screen.id === e.to)
          .map((e) => e.from),
      ).size;
      const makes = [
        ...new Set(
          map.edges
            .filter((e) => MapEdgeKind.MAKES === e.kind && actions.includes(e.from))
            .map((e) => e.to.replace(`${MapNodeKind.THING} `, '')),
        ),
      ];
      const count = (field: 'proven' | 'pressed'): number =>
        actions.filter((id) => 0 < (map.nodes.find((n) => id === n.id)?.[field] ?? 0)).length;
      const tried = count('pressed');
      const facts = [
        ...(0 === actions.length
          ? []
          : [
              `${String(tried)} of ${plural(actions.length, 'action')} tried, ${String(count('proven'))} proven`,
            ]),
        ...(0 === inbound ? [] : [`reached from ${plural(inbound, 'action')}`]),
        ...(0 === makes.length ? [] : [`makes ${makes.join(', ')}`]),
      ];
      return {
        label: screen.label,
        score: inbound + 2 * makes.length,
        untried: actions.length - tried,
        facts,
      };
    })
    .filter((s) => 0 < s.facts.length)
    // The most important first; among equals, the one with the most left to try (the frontier rule).
    .sort((a, b) => b.score - a.score || b.untried - a.untried)
    .slice(0, FRONTIER_NAMED);
  return 0 === screens.length
    ? ''
    : `Most important first: ${screens.map((s) => `${s.label} (${s.facts.join(', ')})`).join(', ')}.`;
}

/**
 * The actions to press to get from one screen to another, by the map's pressed edges: the shortest
 * way, each by the anchor it was pressed with. Empty when already there; undefined when the map knows
 * no way (a run then reaches it some other way, or a replay starts where it is).
 */
export function pathTo(map: AppMap, from: string, to: string): Anchor[] | undefined {
  const start = `${MapNodeKind.SCREEN} ${templatePath(from)}`;
  const goal = `${MapNodeKind.SCREEN} ${templatePath(to)}`;
  if (start === goal) {
    return [];
  }
  const anchors = new Map(
    map.nodes.flatMap((n) => (n.anchor === undefined ? [] : [[n.id, n.anchor] as const])),
  );
  // screen -> (action, next screen), only through actions that can be pressed again.
  const next = new Map<string, { action: string; to: string }[]>();
  for (const has of map.edges.filter((e) => MapEdgeKind.HAS === e.kind && anchors.has(e.to))) {
    for (const lead of map.edges.filter(
      (e) => MapEdgeKind.LEADS_TO === e.kind && has.to === e.from,
    )) {
      next.set(has.from, [...(next.get(has.from) ?? []), { action: has.to, to: lead.to }]);
    }
  }
  const via = new Map<string, { from: string; action: string }>();
  const queue = [start];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const step of next.get(at) ?? []) {
      if (step.to === start || via.has(step.to)) {
        continue;
      }
      via.set(step.to, { from: at, action: step.action });
      if (step.to === goal) {
        const path: Anchor[] = [];
        for (let back = via.get(goal); back !== undefined; back = via.get(back.from)) {
          const anchor = anchors.get(back.action);
          if (anchor !== undefined) {
            path.unshift(anchor);
          }
          if (back.from === start) {
            break;
          }
        }
        return path;
      }
      queue.push(step.to);
    }
  }
  return undefined;
}

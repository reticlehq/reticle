import {
  ElementQuerySchema,
  ElementState,
  EventType,
  type ElementQuery,
  type ReticleEvent,
} from '@reticlehq/core';
import { z } from 'zod';

export type Predicate =
  | { kind: 'element'; query: ElementQuery; state?: ElementState; absent?: boolean }
  | { kind: 'text'; contains: string; visible?: boolean; absent?: boolean }
  | {
      kind: 'net';
      method?: string;
      urlContains?: string;
      status?: number;
      since?: number;
      count?: number;
    }
  | { kind: 'route'; pathname?: string; contains?: string }
  | { kind: 'console'; level?: string; absent?: boolean; since?: number }
  | { kind: 'animation'; name?: string; target?: string; completed?: boolean }
  | { kind: 'signal'; name?: string; dataMatches?: Record<string, unknown> }
  | { kind: 'state'; store?: string; path: string; equals?: unknown }
  | { kind: 'settled'; quietMs?: number }
  | { kind: 'allOf'; predicates: Predicate[] }
  | { kind: 'anyOf'; predicates: Predicate[] }
  | { kind: 'not'; predicate: Predicate };

export const PredicateSchema = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('element'),
      query: ElementQuerySchema,
      state: z.nativeEnum(ElementState).optional(),
      absent: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('text'),
      contains: z.string(),
      visible: z.boolean().optional(),
      absent: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('net'),
      method: z.string().optional(),
      urlContains: z.string().optional(),
      status: z.number().optional(),
      since: z.number().optional(),
      count: z.number().int().nonnegative().optional(),
    }),
    z.object({
      kind: z.literal('route'),
      pathname: z.string().optional(),
      contains: z.string().optional(),
    }),
    z.object({
      kind: z.literal('console'),
      level: z.string().optional(),
      absent: z.boolean().optional(),
      since: z.number().optional(),
    }),
    z.object({
      kind: z.literal('animation'),
      name: z.string().optional(),
      target: z.string().optional(),
      completed: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('signal'),
      name: z.string().optional(),
      dataMatches: z.record(z.unknown()).optional(),
    }),
    z.object({
      kind: z.literal('state'),
      store: z.string().optional(),
      path: z.string(),
      equals: z.unknown().optional(),
    }),
    z.object({ kind: z.literal('settled'), quietMs: z.number().positive().optional() }),
    z.object({ kind: z.literal('allOf'), predicates: z.array(PredicateSchema) }),
    z.object({ kind: z.literal('anyOf'), predicates: z.array(PredicateSchema) }),
    z.object({ kind: z.literal('not'), predicate: PredicateSchema }),
  ]),
) as unknown as z.ZodType<Predicate>;

export interface EvalResult {
  pass: boolean;
  evidence?: unknown;
  failureReason?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Match one value against a pattern. Supports `*` (present), strict equality, and operators:
 * `{$gte,$lte,$gt,$lt}` (numbers), `{$contains}` (array membership or substring), `{$length}`.
 */
export function matchValue(got: unknown, want: unknown): boolean {
  if (want === '*') return got !== undefined;
  if (typeof want === 'object' && want !== null && !Array.isArray(want)) {
    for (const [op, val] of Object.entries(want as Record<string, unknown>)) {
      const n = typeof got === 'number' ? got : NaN;
      switch (op) {
        case '$gte':
          if (!(n >= (val as number))) return false;
          break;
        case '$lte':
          if (!(n <= (val as number))) return false;
          break;
        case '$gt':
          if (!(n > (val as number))) return false;
          break;
        case '$lt':
          if (!(n < (val as number))) return false;
          break;
        case '$contains':
          if (Array.isArray(got)) {
            if (!got.includes(val)) return false;
          } else if (typeof got === 'string') {
            if (!got.includes(String(val))) return false;
          } else {
            return false;
          }
          break;
        case '$length':
          if (!((Array.isArray(got) || typeof got === 'string') && got.length === val)) {
            return false;
          }
          break;
        default:
          return false;
      }
    }
    return true;
  }
  return got === want;
}

/** Shallow JSON pattern match: each key in `pattern` must match (see matchValue). */
function dataMatches(actual: Record<string, unknown>, pattern: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(pattern)) {
    if (!matchValue(actual[key], want)) return false;
  }
  return true;
}

export function evalNet(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: 'net' }>,
): EvalResult {
  const since = p.since ?? 0;
  const matches = events.filter((e) => {
    if (e.type !== EventType.NET_REQUEST || e.t < since) return false;
    const d = e.data;
    if (p.method !== undefined && str(d['method'])?.toUpperCase() !== p.method.toUpperCase()) {
      return false;
    }
    if (p.urlContains !== undefined && !(str(d['url']) ?? '').includes(p.urlContains)) {
      return false;
    }
    if (p.status !== undefined && num(d['status']) !== p.status) return false;
    return true;
  });
  // `count` (exact) turns presence into a cardinality assertion — catches the double-submit /
  // useEffect-double-fire / retry-storm regression class, where the request DID fire (presence passes)
  // but fired the WRONG number of times. Without `count`, the matcher is presence-only (≥1).
  if (p.count !== undefined) {
    return matches.length === p.count
      ? { pass: true, evidence: { matched: matches.length } }
      : {
          pass: false,
          failureReason: `expected ${String(p.count)} network call(s) matching ${JSON.stringify({ method: p.method, urlContains: p.urlContains, status: p.status })}, saw ${String(matches.length)}`,
        };
  }
  const hit = matches[0];
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : { pass: false, failureReason: `no network call matched ${JSON.stringify(p)}` };
}

export function evalRoute(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: 'route' }>,
): EvalResult {
  const routes = events.filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  if (last === undefined) {
    return { pass: false, failureReason: 'no route change observed' };
  }
  const pathname = str(last.data['pathname']) ?? str(last.data['to']) ?? '';
  if (p.pathname !== undefined && pathname !== p.pathname) {
    return { pass: false, failureReason: `route is '${pathname}', expected '${p.pathname}'` };
  }
  if (p.contains !== undefined && !pathname.includes(p.contains)) {
    return { pass: false, failureReason: `route '${pathname}' does not contain '${p.contains}'` };
  }
  return { pass: true, evidence: last.data };
}

/** The only console levels Reticle instruments (console.info/debug/trace are NOT patched). */
const CONSOLE_LEVEL_TYPE: Readonly<Record<string, EventType>> = {
  log: EventType.CONSOLE_LOG,
  warn: EventType.CONSOLE_WARN,
  error: EventType.CONSOLE_ERROR,
};

export function evalConsole(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: 'console' }>,
): EvalResult {
  const since = p.since ?? 0;
  // Reticle only instruments console.log/warn/error. A level outside that set is never captured,
  // so its events can't exist — and an `absent` assertion on it would verify NOTHING while
  // reporting green. Fail loudly instead of false-passing.
  if (
    p.level !== undefined &&
    p.level !== 'error' &&
    CONSOLE_LEVEL_TYPE[p.level] === undefined
  ) {
    return {
      pass: false,
      failureReason: `console level '${p.level}' is not captured — Reticle instruments console.log, console.warn, console.error only`,
    };
  }
  const matches = events.filter((e) => {
    if (e.t < since) return false;
    const isErr = e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT;
    if (p.level === undefined) {
      return (
        e.type === EventType.CONSOLE_LOG ||
        e.type === EventType.CONSOLE_WARN ||
        e.type === EventType.CONSOLE_ERROR ||
        e.type === EventType.ERROR_UNCAUGHT
      );
    }
    if (p.level === 'error') return isErr;
    return e.type === CONSOLE_LEVEL_TYPE[p.level];
  });
  if (p.absent === true) {
    return matches.length === 0
      ? { pass: true, evidence: { absent: true } }
      : {
          pass: false,
          failureReason: `expected no ${p.level ?? 'console'} entries but found ${String(matches.length)}`,
          evidence: matches.map((e) => e.data),
        };
  }
  return matches.length > 0
    ? { pass: true, evidence: matches.map((e) => e.data) }
    : { pass: false, failureReason: `no ${p.level ?? 'console'} entries found` };
}

export function evalAnimation(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: 'animation' }>,
): EvalResult {
  const wantType = p.completed === true ? EventType.ANIM_END : EventType.ANIM_START;
  const hit = events.find((e) => {
    if (e.type !== wantType) return false;
    if (p.name !== undefined && str(e.data['name']) !== p.name) return false;
    if (p.target !== undefined && e.ref !== p.target) return false;
    return true;
  });
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : { pass: false, failureReason: `no animation matched ${JSON.stringify(p)}` };
}

export function evalSignal(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: 'signal' }>,
): EvalResult {
  const hit = events.find((e) => {
    if (e.type !== EventType.SIGNAL) return false;
    if (p.name !== undefined && str(e.data['name']) !== p.name) return false;
    if (p.dataMatches !== undefined) {
      const payload = (e.data['data'] ?? {}) as Record<string, unknown>;
      if (!dataMatches(payload, p.dataMatches)) return false;
    }
    return true;
  });
  if (hit !== undefined) return { pass: true, evidence: hit.data };

  // Near-miss: show signals that fired with the same name (so the agent sees the real data).
  const sameName = events
    .filter(
      (e) =>
        e.type === EventType.SIGNAL && (p.name === undefined || str(e.data['name']) === p.name),
    )
    .map((e) => e.data['data'] ?? e.data);
  return {
    pass: false,
    failureReason:
      sameName.length > 0
        ? `signal '${p.name ?? '(any)'}' fired ${String(sameName.length)}x but data didn't match`
        : `no signal matched ${JSON.stringify(p)}`,
    evidence: sameName.length > 0 ? { nearMiss: sameName } : undefined,
  };
}

/**
 * Assert a value inside a registered store — the deterministic source of truth no DOM/network read
 * can reach. Reads the store (STATE_READ), walks `path` (dot-path, numeric array indices), and matches
 * the value against `equals` (a literal, `*` for presence, or a `{$gte,$contains,$length,…}` operator
 * pattern — same matcher as signal `dataMatches`). This is what turns "the UI lies about the store"
 * from a manual three-step catch into a one-line, LLM-free regression invariant a flow can carry.
 */

/**
 * Activity that resets the "quiet" timer for a `settled` predicate: network calls and STRUCTURAL DOM
 * mutations (nodes added/removed, attributes changed). Deliberately EXCLUDES `dom.text` and animation
 * frames: a count-up counter, a spinner, a pulsing dot, or any looping CSS animation emits a text/anim
 * event every frame forever, so an app with ambient motion would NEVER go quiet (observed live: one
 * login flooded 319 dom.text events from the dashboard's count-up animations). That is the same trap
 * that got Playwright's `networkidle` deprecated. Network + structural DOM are the real "the app is
 * still doing work" signals; for an outcome gated on an animation finishing, assert that specific
 * consequence (signal/net) instead of relying on settle.
 */
const SETTLE_ACTIVITY: ReadonlySet<EventType> = new Set([
  EventType.NET_REQUEST,
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
]);

/** Default quiet window — enough to absorb a render+xhr settle without waiting on slow polls. */
const DEFAULT_QUIET_MS = 500;

/**
 * "The page has gone quiet": no network/DOM/animation activity for at least `quietMs`. Needs the
 * wall-clock `now` (in the buffer's time base) because "no activity in the last N ms" is relative to
 * now, not to any buffered event — so `now` is injected (CLAUDE.md rule 7), and the wait loop's
 * poll interval is what eventually flips this to pass once activity stops.
 */
export function evalSettled(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: 'settled' }>,
  now: number,
): EvalResult {
  const quietMs = p.quietMs ?? DEFAULT_QUIET_MS;

  // A request that STARTED (NET_PENDING) but never completed (NET_REQUEST with the same id) is
  // still in flight — the page is NOT settled no matter how quiet the DOM has gone. Without this,
  // a slow save reads as "settled" the instant its spinner stops mutating the DOM: the exact
  // false-green `settled` exists to prevent.
  const doneIds = new Set<string>();
  for (const e of events) {
    if (e.type === EventType.NET_REQUEST) {
      const id = str(e.data['id']);
      if (id !== undefined) doneIds.add(id);
    }
  }
  let inFlight = 0;
  for (const e of events) {
    if (e.type === EventType.NET_PENDING) {
      const id = str(e.data['id']);
      if (id === undefined || !doneIds.has(id)) inFlight += 1;
    }
  }
  if (inFlight > 0) {
    return {
      pass: false,
      failureReason: `not settled: ${String(inFlight)} request(s) still in flight`,
      evidence: { settled: false, inFlight },
    };
  }

  let lastT = -1;
  let lastType: EventType | undefined;
  for (const e of events) {
    if (SETTLE_ACTIVITY.has(e.type) && e.t > lastT) {
      lastT = e.t;
      lastType = e.type;
    }
  }
  if (lastT < 0) {
    return {
      pass: true,
      evidence: { settled: true, quietForMs: null, note: 'no activity to settle' },
    };
  }
  const quietForMs = now - lastT;
  if (quietForMs >= quietMs) {
    return { pass: true, evidence: { settled: true, quietForMs, lastActivity: lastType } };
  }
  return {
    pass: false,
    failureReason: `not settled: last activity (${String(lastType)}) ${String(quietForMs)}ms ago, need ${String(quietMs)}ms quiet`,
    evidence: { quietForMs, lastActivity: lastType },
  };
}

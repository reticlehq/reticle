import {
  ElementQuerySchema,
  ElementState,
  EventType,
  IrisCommand,
  type CommandResult,
  type ElementQuery,
  type IrisEvent,
  type MatchResult,
} from '@syrin/iris-protocol';
import { z } from 'zod';

/** The subset of Session the predicate engine needs — keeps it testable with a fake. */
export interface PredicateSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): IrisEvent[];
  onEvent(listener: (event: IrisEvent) => void): () => void;
  /** Milliseconds since connect — the same clock that stamps event `t` (injected, testable). */
  elapsed(): number;
}

/** The predicate DSL (plan/06). A declarative description of what should be true. */
export type Predicate =
  | { kind: 'element'; query: ElementQuery; state?: ElementState; absent?: boolean }
  | { kind: 'text'; contains: string; visible?: boolean; absent?: boolean }
  | { kind: 'net'; method?: string; urlContains?: string; status?: number; since?: number }
  | { kind: 'route'; pathname?: string; contains?: string }
  | { kind: 'console'; level?: string; absent?: boolean; since?: number }
  | { kind: 'animation'; name?: string; target?: string; completed?: boolean }
  | { kind: 'signal'; name?: string; dataMatches?: Record<string, unknown> }
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
function matchValue(got: unknown, want: unknown): boolean {
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

async function matchOnce(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
): Promise<MatchResult> {
  const res = await session.command(IrisCommand.MATCH, { query, state });
  if (!res.ok) return { matched: false, count: 0, elements: [] };
  return (res.result ?? { matched: false, count: 0, elements: [] }) as MatchResult;
}

async function evalElement(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
  absent: boolean,
): Promise<EvalResult> {
  const match = await matchOnce(session, query, state);
  if (absent) {
    return match.matched
      ? {
          pass: false,
          failureReason: `expected element to be absent but found ${String(match.count)}`,
          evidence: match.elements,
        }
      : { pass: true, evidence: { absent: true } };
  }
  if (match.matched) return { pass: true, evidence: match.elements };

  // Diagnostic near-miss: was it there but in the wrong state, or a similar element present?
  if (state !== undefined) {
    const relaxed = await matchOnce(session, query, undefined);
    if (relaxed.matched) {
      return {
        pass: false,
        failureReason: `element exists but not in state '${state}'`,
        evidence: { nearMiss: relaxed.elements },
      };
    }
  }
  if (query.role !== undefined && query.name !== undefined) {
    const roleOnly = await matchOnce(session, { role: query.role }, state);
    if (roleOnly.matched) {
      return {
        pass: false,
        failureReason: `no '${query.role}' named '${query.name}'; saw: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        evidence: { nearMiss: roleOnly.elements },
      };
    }
  }
  return {
    pass: false,
    failureReason: `no element matched ${JSON.stringify(query)}${state === undefined ? '' : ` in state '${state}'`}`,
  };
}

function evalNet(events: IrisEvent[], p: Extract<Predicate, { kind: 'net' }>): EvalResult {
  const since = p.since ?? 0;
  const hit = events.find((e) => {
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
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : { pass: false, failureReason: `no network call matched ${JSON.stringify(p)}` };
}

function evalRoute(events: IrisEvent[], p: Extract<Predicate, { kind: 'route' }>): EvalResult {
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

function evalConsole(events: IrisEvent[], p: Extract<Predicate, { kind: 'console' }>): EvalResult {
  const since = p.since ?? 0;
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
    return e.type === `console.${p.level}`;
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

function evalAnimation(
  events: IrisEvent[],
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

function evalSignal(events: IrisEvent[], p: Extract<Predicate, { kind: 'signal' }>): EvalResult {
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
 * Activity that resets the "quiet" timer for a `settled` predicate: any network call, DOM mutation,
 * or animation frame. When the most recent such event is older than `quietMs`, the page is settled.
 */
const SETTLE_ACTIVITY: ReadonlySet<EventType> = new Set([
  EventType.NET_REQUEST,
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
  EventType.DOM_TEXT,
  EventType.ANIM_START,
  EventType.ANIM_END,
]);

/** Default quiet window — enough to absorb a render+xhr settle without waiting on slow polls. */
const DEFAULT_QUIET_MS = 500;

/**
 * "The page has gone quiet": no network/DOM/animation activity for at least `quietMs`. Needs the
 * wall-clock `now` (in the buffer's time base) because "no activity in the last N ms" is relative to
 * now, not to any buffered event — so `now` is injected (CLAUDE.md rule 7), and the wait loop's
 * poll interval is what eventually flips this to pass once activity stops.
 */
function evalSettled(
  events: IrisEvent[],
  p: Extract<Predicate, { kind: 'settled' }>,
  now: number,
): EvalResult {
  const quietMs = p.quietMs ?? DEFAULT_QUIET_MS;
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

/**
 * Evaluate a predicate once against the session's current state + event buffer.
 *
 * `since` is an event-time floor: buffer-backed predicates (net/console/animation/signal/route)
 * only consider events at/after it. Callers default it to the last act's cursor so a stale signal
 * buffered before the action can never fake a pass (the honesty fix). Default 0 = whole buffer.
 */
export async function evaluatePredicate(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
): Promise<EvalResult> {
  const events = session.eventsSince(since);
  switch (predicate.kind) {
    case 'element':
      return evalElement(session, predicate.query, predicate.state, predicate.absent ?? false);
    case 'text':
      return evalElement(
        session,
        { text: predicate.contains },
        predicate.visible === true ? ElementState.VISIBLE : undefined,
        predicate.absent ?? false,
      );
    case 'net':
      return evalNet(events, predicate);
    case 'route':
      return evalRoute(events, predicate);
    case 'console':
      return evalConsole(events, predicate);
    case 'animation':
      return evalAnimation(events, predicate);
    case 'signal':
      return evalSignal(events, predicate);
    case 'settled':
      return evalSettled(events, predicate, session.elapsed());
    case 'allOf': {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p, since)),
      );
      const failed = results.find((r) => !r.pass);
      return failed === undefined
        ? { pass: true, evidence: results.map((r) => r.evidence) }
        : {
            pass: false,
            failureReason: failed.failureReason ?? 'a sub-predicate of allOf failed',
            evidence: results,
          };
    }
    case 'anyOf': {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p, since)),
      );
      const passed = results.find((r) => r.pass);
      return passed !== undefined
        ? { pass: true, evidence: passed.evidence }
        : { pass: false, failureReason: 'no sub-predicate of anyOf matched', evidence: results };
    }
    case 'not': {
      const inner = await evaluatePredicate(session, predicate.predicate, since);
      return inner.pass
        ? { pass: false, failureReason: 'negated predicate unexpectedly held', evidence: inner }
        : { pass: true };
    }
    default:
      return { pass: false, failureReason: 'unknown predicate' };
  }
}

/**
 * Evaluate now, else wait for it to become true (on each event + a poll) until timeout. `since` is
 * the event-time floor (see evaluatePredicate) so a waiter cannot resolve on a stale buffered event.
 */
export function waitForPredicate(
  session: PredicateSession,
  predicate: Predicate,
  timeoutMs: number,
  since = 0,
): Promise<EvalResult> {
  return new Promise<EvalResult>((resolve) => {
    let done = false;
    const failed = (error: unknown): EvalResult => ({
      pass: false,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    const finish = (result: EvalResult): void => {
      if (done) return;
      done = true;
      unsub();
      clearInterval(interval);
      clearTimeout(timer);
      resolve(result);
    };
    const check = (): void => {
      void evaluatePredicate(session, predicate, since)
        .then((r) => {
          if (r.pass) finish(r);
        })
        .catch((error: unknown) => {
          finish(failed(error));
        });
    };
    const unsub = session.onEvent(() => {
      check();
    });
    const interval = setInterval(check, 150);
    const timer = setTimeout(() => {
      void evaluatePredicate(session, predicate, since)
        .then((r) => {
          finish({
            pass: false,
            evidence: r.evidence,
            failureReason: r.failureReason ?? 'timed out waiting for predicate',
          });
        })
        .catch((error: unknown) => {
          finish(failed(error));
        });
    }, timeoutMs);
    check();
  });
}

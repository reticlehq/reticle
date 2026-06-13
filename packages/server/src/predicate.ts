import {
  ElementQuerySchema,
  ElementState,
  EventType,
  IrisCommand,
  type CommandResult,
  type ElementQuery,
  type IrisEvent,
  type MatchResult,
} from '@iris/protocol';
import { z } from 'zod';

/** The subset of Session the predicate engine needs — keeps it testable with a fake. */
export interface PredicateSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): IrisEvent[];
  onEvent(listener: (event: IrisEvent) => void): () => void;
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

/** Shallow JSON pattern match with `*` wildcard support. */
function dataMatches(actual: Record<string, unknown>, pattern: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(pattern)) {
    const got = actual[key];
    if (want === '*') {
      if (got === undefined) return false;
      continue;
    }
    if (got !== want) return false;
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
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : { pass: false, failureReason: `no signal matched ${JSON.stringify(p)}` };
}

/** Evaluate a predicate once against the session's current state + event buffer. */
export async function evaluatePredicate(
  session: PredicateSession,
  predicate: Predicate,
): Promise<EvalResult> {
  const events = session.eventsSince(0);
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
    case 'allOf': {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p)),
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
        predicate.predicates.map((p) => evaluatePredicate(session, p)),
      );
      const passed = results.find((r) => r.pass);
      return passed !== undefined
        ? { pass: true, evidence: passed.evidence }
        : { pass: false, failureReason: 'no sub-predicate of anyOf matched', evidence: results };
    }
    case 'not': {
      const inner = await evaluatePredicate(session, predicate.predicate);
      return inner.pass
        ? { pass: false, failureReason: 'negated predicate unexpectedly held', evidence: inner }
        : { pass: true };
    }
    default:
      return { pass: false, failureReason: 'unknown predicate' };
  }
}

/** Evaluate now, else wait for it to become true (on each event + a poll) until timeout. */
export function waitForPredicate(
  session: PredicateSession,
  predicate: Predicate,
  timeoutMs: number,
): Promise<EvalResult> {
  return new Promise<EvalResult>((resolve) => {
    let done = false;
    const finish = (result: EvalResult): void => {
      if (done) return;
      done = true;
      unsub();
      clearInterval(interval);
      clearTimeout(timer);
      resolve(result);
    };
    const check = (): void => {
      void evaluatePredicate(session, predicate).then((r) => {
        if (r.pass) finish(r);
      });
    };
    const unsub = session.onEvent(() => {
      check();
    });
    const interval = setInterval(check, 150);
    const timer = setTimeout(() => {
      void evaluatePredicate(session, predicate).then((r) => {
        finish({
          pass: false,
          evidence: r.evidence,
          failureReason: r.failureReason ?? 'timed out waiting for predicate',
        });
      });
    }, timeoutMs);
    check();
  });
}

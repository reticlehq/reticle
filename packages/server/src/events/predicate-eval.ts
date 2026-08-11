import {
  ElementQuerySchema,
  ElementState,
  EventType,
  PredicateKind,
  StreamDirection,
  isDevToolingUrl,
  type ElementQuery,
  type ReticleEvent,
} from '@reticlehq/core';
import { z } from 'zod';
import { describeObserved } from './observed-in-window.js';

export type Predicate =
  | {
      kind: typeof PredicateKind.ELEMENT;
      query: ElementQuery;
      state?: ElementState;
      absent?: boolean;
    }
  | { kind: typeof PredicateKind.TEXT; contains: string; visible?: boolean; absent?: boolean }
  | {
      kind: typeof PredicateKind.NET;
      method?: string;
      urlContains?: string;
      status?: number;
      /** Did the call succeed? The honest field for IPC, which has no status code. */
      ok?: boolean;
      since?: number;
      count?: number;
    }
  | { kind: typeof PredicateKind.ROUTE; pathname?: string; contains?: string; since?: number }
  | { kind: typeof PredicateKind.CONSOLE; level?: string; absent?: boolean; since?: number }
  | {
      kind: typeof PredicateKind.ANIMATION;
      name?: string;
      target?: string;
      completed?: boolean;
      since?: number;
    }
  | {
      kind: typeof PredicateKind.SIGNAL;
      name?: string;
      dataMatches?: Record<string, unknown>;
      since?: number;
    }
  | { kind: typeof PredicateKind.STATE; store?: string; path: string; equals?: unknown }
  | { kind: typeof PredicateKind.SETTLED; quietMs?: number }
  | { kind: typeof PredicateKind.ALL_OF; predicates: Predicate[] }
  | { kind: typeof PredicateKind.ANY_OF; predicates: Predicate[] }
  | { kind: typeof PredicateKind.NOT; predicate: Predicate };

/**
 * Spellings an agent plausibly reaches for, mapped to the real field.
 *
 * `route` spells its field `pathname` while `state`, in the same union, spells its `path`. Every one
 * of these was silently DROPPED before, and because these kinds have all-optional fields, dropping
 * the only key supplied left a predicate that asserts nothing and passes on anything.
 */
const PREDICATE_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // `urlContains`/`url` reported from the field: an agent that had just written
  // `net { urlContains }` applied the same word to `route`, which spells it `contains`, and got
  // `unrecognized_keys` with no list of what would have worked. The parallel it assumed is a fair
  // one — route's `contains` matches the WHOLE route (path + query + fragment), so "the URL
  // contains this" is precisely what it does — and asserting a redirect after login is the single
  // most common thing an agent reaches for here.
  [PredicateKind.ROUTE]: { path: 'pathname', urlContains: 'contains', url: 'contains' },
  [PredicateKind.NET]: { url: 'urlContains' },
  [PredicateKind.SIGNAL]: { data: 'dataMatches' },
};

/** Rename known aliases before parse; an explicit canonical key always wins. */
function applyPredicateAliases(input: unknown): unknown {
  if (typeof input !== 'object' || null === input || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  const aliases = PREDICATE_ALIASES['string' === typeof obj['kind'] ? obj['kind'] : ''];
  if (aliases === undefined) return input;
  const out = { ...obj };
  for (const [from, to] of Object.entries(aliases)) {
    if (out[from] === undefined) continue;
    if (out[to] === undefined) out[to] = out[from];
    delete out[from];
  }
  return out;
}

/**
 * Strict on every branch. A key that is nobody's spelling is now a schema error naming it, instead of
 * a stripped field and a green — see predicate-strict.test.ts for the MCP session that found this.
 */
export const PredicateSchema = z.lazy(() =>
  z.preprocess(
    applyPredicateAliases,
    z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal(PredicateKind.ELEMENT),
          query: ElementQuerySchema,
          state: z.nativeEnum(ElementState).optional(),
          absent: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.TEXT),
          contains: z.string(),
          visible: z.boolean().optional(),
          absent: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.NET),
          method: z.string().optional(),
          urlContains: z.string().optional(),
          status: z.number().optional(),
          ok: z.boolean().optional(),
          since: z.number().optional(),
          count: z.number().int().nonnegative().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.ROUTE),
          pathname: z.string().optional(),
          contains: z.string().optional(),
          since: z.number().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.CONSOLE),
          level: z.string().optional(),
          absent: z.boolean().optional(),
          since: z.number().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.ANIMATION),
          name: z.string().optional(),
          target: z.string().optional(),
          completed: z.boolean().optional(),
          since: z.number().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.SIGNAL),
          name: z.string().optional(),
          dataMatches: z.record(z.unknown()).optional(),
          since: z.number().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.STATE),
          store: z.string().optional(),
          path: z.string(),
          equals: z.unknown().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal(PredicateKind.SETTLED),
          quietMs: z.number().positive().optional(),
        })
        .strict(),
      z
        .object({ kind: z.literal(PredicateKind.ALL_OF), predicates: z.array(PredicateSchema) })
        .strict(),
      z
        .object({ kind: z.literal(PredicateKind.ANY_OF), predicates: z.array(PredicateSchema) })
        .strict(),
      z.object({ kind: z.literal(PredicateKind.NOT), predicate: PredicateSchema }).strict(),
    ]),
  ),
) as unknown as z.ZodType<Predicate>;

export interface EvalResult {
  pass: boolean;
  /**
   * For a TIME-based failure: how long until this predicate could first become true, if nothing else
   * changes. Purely a scheduling hint for `waitForPredicate` — it replaces a blind poll tick with one
   * timed to the moment that matters, and never decides anything. Absent when the wait is on an
   * external event (a request in flight settles when the server answers, not on a clock).
   */
  retryAfterMs?: number;
  /**
   * Set when the assertion could not be EVALUATED — the call was under-specified or there was
   * nothing instrumented to read — rather than evaluated and found false. Carries the sentence that
   * names what is missing.
   *
   * `pass` stays false because nothing was proven, but a false that nobody could have made true is
   * not a defect in the user's app, and reporting it as one puts agent mistakes into the bug count.
   */
  inconclusive?: string;
  evidence?: unknown;
  failureReason?: string;
  /**
   * The wait ended because the TAB went away, not because the app did anything observable.
   *
   * A sibling of `inconclusive` and for the same reason: `pass` is false because nothing was
   * proven, but nobody could have made it true, so grading it as a defect in the user's app is a
   * false claim. Without this the verdict rule saw only `pass: false` and answered
   * `assertion_failed` — "the declared consequence did not hold" — naming the component the agent
   * had just clicked. See VerifiedReason.OBSERVATION_LOST.
   */
  observationLost?: boolean;
  /**
   * The failure, structured — what was seen, what was required, and which oracle judged it.
   *
   * `failureReason` says the same thing in prose, and prose is the WRONG shape for this: measured on
   * three seeded bugs, an agent handed observed/expected/assertion alongside the source pointer used
   * fewer tool calls than one handed the pointer alone, and the repair literature has structured
   * feedback beating rich natural-language feedback by 10.5pp. The prose stays for humans reading a
   * log; these three fields are for the agent.
   *
   * Optional because they are populated per oracle, not globally — see the note in predicate.ts on
   * which classes carry them today.
   */
  observed?: string;
  expected?: string;
  assertion?: string;
}

function str(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}
function num(value: unknown): number | undefined {
  return 'number' === typeof value ? value : undefined;
}

/**
 * Match one value against a pattern. Supports `*` (present), strict equality, and operators:
 * `{$gte,$lte,$gt,$lt}` (numbers), `{$contains}` (array membership or substring), `{$length}`.
 */
export function matchValue(got: unknown, want: unknown): boolean {
  if ('*' === want) return got !== undefined;
  // An object is an OPERATOR container only if it actually carries a `$`-prefixed operator. An empty
  // `{}` (or an object with no `$` key) used to enter this branch, iterate zero recognized operators,
  // and `return true` — so `equals: {}` / `dataMatches: {status: {}}` was a green assertion that
  // passed against ANYTHING, undefined included: the exact false green the oracle exists to catch.
  // Without an operator it is a literal to compare, and falls through to strict equality below.
  const ops =
    'object' === typeof want && want !== null && !Array.isArray(want)
      ? Object.entries(want as Record<string, unknown>)
      : undefined;
  if (ops !== undefined && ops.some(([op]) => op.startsWith('$'))) {
    for (const [op, val] of ops) {
      const n = 'number' === typeof got ? got : NaN;
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
          } else if ('string' === typeof got) {
            if (!got.includes(String(val))) return false;
          } else {
            return false;
          }
          break;
        case '$length':
          if (!((Array.isArray(got) || 'string' === typeof got) && got.length === val)) {
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

/**
 * Did this call succeed, as the app experienced it?
 *
 * `ok` is authoritative when present — IPC sets it explicitly, because an IPC call has no status
 * code and the 200/500 Reticle derives is a convenience, not a fact. Falling back to the HTTP status
 * keeps ordinary web requests working without the observer having to set the field everywhere.
 *
 * This exists so an agent can assert on the OUTCOME rather than on a number Reticle invented.
 */
function callSucceeded(data: Record<string, unknown>): boolean {
  if ('boolean' === typeof data['ok']) return data['ok'];
  const status = num(data['status']);
  return status === undefined || status < 400;
}

export function evalNet(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
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
    if (p.ok !== undefined && callSucceeded(d) !== p.ok) return false;
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
          observed: `${String(matches.length)} matching network call(s)`,
          expected: `exactly ${String(p.count)} matching ${JSON.stringify({ method: p.method, urlContains: p.urlContains, status: p.status })}`,
          assertion: 'net.count',
        };
  }
  const hit = matches[0];
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : {
        pass: false,
        failureReason: `no network call matched ${JSON.stringify(p)}`,
        // Same reasoning as the signal miss: "no matching call" cannot be told apart from "the app
        // made no calls at all", and those need different fixes.
        observed: describeObserved(
          'calls',
          events
            .filter((e) => e.type === EventType.NET_REQUEST)
            .map((e) => `${str(e.data['method']) ?? 'GET'} ${str(e.data['url']) ?? ''}`),
        ),
        expected: `at least one call matching ${JSON.stringify(p)}`,
        assertion: 'net.present',
      };
}

export function evalRoute(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.ROUTE }>,
): EvalResult {
  const routes = events.filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  if (last === undefined) {
    return {
      pass: false,
      failureReason: 'no route change observed',
      observed: 'no route change in the window',
      expected: `a route change to ${p.pathname ?? p.contains ?? 'any route'}`,
      assertion: 'route.changed',
    };
  }
  const pathname = str(last.data['pathname']) ?? str(last.data['to']) ?? '';
  if (p.pathname !== undefined && pathname !== p.pathname) {
    return {
      pass: false,
      failureReason: `route is '${pathname}', expected '${p.pathname}'`,
      observed: `route '${pathname}'`,
      expected: `route '${p.pathname}'`,
      assertion: 'route.pathname',
    };
  }
  // `contains` matches the WHOLE route — path + query + fragment — while `pathname` above stays an
  // exact path match. A hash router keeps the entire route in the fragment, so matching pathname
  // alone made `contains` unsatisfiable for every HashRouter app; that is the standard router for a
  // packaged Electron/Tauri renderer, where an absolute pushState would rewrite the URL to a
  // nonexistent file.
  const fullRoute = `${pathname}${str(last.data['search']) ?? ''}${str(last.data['hash']) ?? ''}`;
  if (p.contains !== undefined && !fullRoute.includes(p.contains)) {
    return {
      pass: false,
      failureReason: `route '${fullRoute}' does not contain '${p.contains}'`,
      observed: `route '${fullRoute}'`,
      expected: `a route containing '${p.contains}'`,
      assertion: 'route.contains',
    };
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
  p: Extract<Predicate, { kind: typeof PredicateKind.CONSOLE }>,
): EvalResult {
  const since = p.since ?? 0;
  // Reticle only instruments console.log/warn/error. A level outside that set is never captured,
  // so its events can't exist — and an `absent` assertion on it would verify NOTHING while
  // reporting green. Fail loudly instead of false-passing.
  if (p.level !== undefined && p.level !== 'error' && CONSOLE_LEVEL_TYPE[p.level] === undefined) {
    return {
      pass: false,
      failureReason: `console level '${p.level}' is not captured — Reticle instruments console.log, console.warn, console.error only`,
      observed: `level '${p.level}' is not instrumented, so no event of it can ever exist`,
      expected: 'a level Reticle captures: log, warn, or error',
      assertion: 'console.uninstrumented-level',
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
    if ('error' === p.level) return isErr;
    return e.type === CONSOLE_LEVEL_TYPE[p.level];
  });
  if (true === p.absent) {
    return 0 === matches.length
      ? { pass: true, evidence: { absent: true } }
      : {
          pass: false,
          failureReason: `expected no ${p.level ?? 'console'} entries but found ${String(matches.length)}`,
          observed: `${String(matches.length)} ${p.level ?? 'console'} entr${1 === matches.length ? 'y' : 'ies'}`,
          expected: `no ${p.level ?? 'console'} entries`,
          assertion: 'console.absent',
          evidence: matches.map((e) => e.data),
        };
  }
  return matches.length > 0
    ? { pass: true, evidence: matches.map((e) => e.data) }
    : {
        pass: false,
        failureReason: `no ${p.level ?? 'console'} entries found`,
        observed: `no ${p.level ?? 'console'} entries in the window`,
        expected: `at least one ${p.level ?? 'console'} entry`,
        assertion: 'console.present',
      };
}

export function evalAnimation(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.ANIMATION }>,
): EvalResult {
  const wantType = true === p.completed ? EventType.ANIM_END : EventType.ANIM_START;
  const hit = events.find((e) => {
    if (e.type !== wantType) return false;
    if (p.name !== undefined && str(e.data['name']) !== p.name) return false;
    if (p.target !== undefined && e.ref !== p.target) return false;
    return true;
  });
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : {
        pass: false,
        failureReason: `no animation matched ${JSON.stringify(p)}`,
        observed: 'no matching animation in the window',
        expected: `an animation matching ${JSON.stringify(p)}`,
        assertion: 'animation.present',
      };
}

export function evalSignal(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.SIGNAL }>,
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
    observed:
      sameName.length > 0
        ? `signal '${p.name ?? '(any)'}' fired ${String(sameName.length)}x, payload: ${JSON.stringify(sameName[0])}`
        : // Name what DID fire: a typo'd signal name and a genuinely dead action produce the same
          // sentence otherwise, and the agent cannot tell them apart. See observed-in-window.ts.
          `signal '${p.name ?? '(any)'}' never fired — ${describeObserved(
            'signals',
            events.filter((e) => e.type === EventType.SIGNAL).map((e) => str(e.data['name']) ?? ''),
          )}`,
    expected:
      p.dataMatches === undefined
        ? `signal '${p.name ?? '(any)'}' to fire`
        : `signal '${p.name ?? '(any)'}' with payload matching ${JSON.stringify(p.dataMatches)}`,
    // Two distinct failures behind one prose line: never fired at all, versus fired with the wrong
    // payload. They call for different fixes, so the agent should not have to tell them apart by
    // reading the sentence.
    assertion: sameName.length > 0 ? 'signal.payload' : 'signal.absent',
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

/** The three net-shaped event types a URL can be read off — the only ones dev tooling can produce. */
const NET_TYPES: ReadonlySet<EventType> = new Set([
  EventType.NET_PENDING,
  EventType.NET_REQUEST,
  EventType.NET_STREAM,
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
  allEvents: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.SETTLED }>,
  now: number,
): EvalResult {
  const quietMs = p.quietMs ?? DEFAULT_QUIET_MS;

  // Dev-tooling traffic is the framework talking about ITSELF (see DevToolingChannel) and says
  // nothing about whether the app finished its work — but it was holding settle open. Dropped from
  // both halves of the calculation below (in-flight AND the quiet timer) and DISCLOSED on the
  // evidence, never silently swallowed.
  const ignoredDevTooling: string[] = [];
  const events = allEvents.filter((e) => {
    if (!NET_TYPES.has(e.type)) return true;
    const url = str(e.data['url']);
    if (!isDevToolingUrl(url)) return true;
    if (url !== undefined && !ignoredDevTooling.includes(url)) ignoredDevTooling.push(url);
    return false;
  });
  const disclosure = 0 === ignoredDevTooling.length ? {} : { ignoredDevTooling };

  // A request that STARTED (NET_PENDING) but never completed (NET_REQUEST with the same id) is
  // still in flight — the page is NOT settled no matter how quiet the DOM has gone. Without this,
  // a slow save reads as "settled" the instant its spinner stops mutating the DOM: the exact
  // false-green `settled` exists to prevent.
  //
  // COUNT per id, don't just set-membership: a retry that reuses a request id (two NET_PENDING, one
  // NET_REQUEST) would mark the id "done" and hide the second, still-flying request — an in-flight
  // UNDERCOUNT that greens settle while a request is live. In-flight for an id is pendings minus
  // completions (floored at 0); unkeyed pendings each count as one.
  const pendingById = new Map<string, number>();
  const doneById = new Map<string, number>();
  let unkeyedPending = 0;
  for (const e of events) {
    if (e.type === EventType.NET_PENDING) {
      const id = str(e.data['id']);
      if (id === undefined) unkeyedPending += 1;
      else pendingById.set(id, (pendingById.get(id) ?? 0) + 1);
    } else if (e.type === EventType.NET_REQUEST) {
      const id = str(e.data['id']);
      if (id !== undefined) doneById.set(id, (doneById.get(id) ?? 0) + 1);
    }
  }
  let inFlight = unkeyedPending;
  for (const [id, pending] of pendingById) {
    inFlight += Math.max(0, pending - (doneById.get(id) ?? 0));
  }

  // A completed request whose BODY is still streaming is not a finished request. `fetch` resolves at
  // HEADERS, so on a Next.js App Router page the RSC payload reported complete 16 ms in while the
  // Suspense boundary's content arrived 889 ms later — and the silence between them read as a settled
  // page with a loading spinner still on screen. An OPEN with no CLOSE is in flight, counted the same
  // way as a pending with no completion.
  const openStreams = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.NET_STREAM) continue;
    const id = str(e.data['id']);
    if (id === undefined) continue;
    const direction = str(e.data['direction']);
    if (StreamDirection.OPEN === direction) openStreams.add(id);
    else if (StreamDirection.CLOSE === direction) openStreams.delete(id);
  }
  const streaming = openStreams.size;

  if (inFlight + streaming > 0) {
    const what =
      0 === streaming
        ? `${String(inFlight)} request(s) still in flight`
        : 0 === inFlight
          ? `${String(streaming)} response body(ies) still streaming`
          : `${String(inFlight)} request(s) in flight and ${String(streaming)} response body(ies) still streaming`;
    return {
      pass: false,
      failureReason: `not settled: ${what}`,
      observed: what,
      expected: 'no requests in flight and no response bodies still streaming',
      assertion: 'settled.in-flight',
      evidence: {
        settled: false,
        inFlight,
        ...(streaming > 0 ? { streaming } : {}),
        ...disclosure,
      },
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
      evidence: { settled: true, quietForMs: null, note: 'no activity to settle', ...disclosure },
    };
  }
  const quietForMs = now - lastT;
  if (quietForMs >= quietMs) {
    return {
      pass: true,
      evidence: { settled: true, quietForMs, lastActivity: lastType, ...disclosure },
    };
  }
  return {
    pass: false,
    failureReason: `not settled: last activity (${String(lastType)}) ${String(quietForMs)}ms ago, need ${String(quietMs)}ms quiet`,
    observed: `last activity was ${String(lastType)}, ${String(quietForMs)}ms ago`,
    expected: `${String(quietMs)}ms of quiet`,
    assertion: 'settled.quiet',
    evidence: { quietForMs, lastActivity: lastType, ...disclosure },
    // The one failure in this file that knows exactly when it could stop being one: if nothing else
    // happens, the window closes in this many ms. A waiter that re-checks THEN instead of on its next
    // blind tick stops paying up to a full poll interval on the hottest call in the product. Only a
    // hint — the predicate is still evaluated at that moment, and can still fail.
    retryAfterMs: quietMs - quietForMs,
  };
}

import {
  ElementState,
  ReticleCommand,
  type CommandResult,
  type ElementQuery,
  type ReticleEvent,
  type MatchResult,
} from '@reticlehq/protocol';
import { selectPath, capDepth } from '../session/state-select.js';
import {
  PredicateSchema,
  matchValue,
  evalNet,
  evalRoute,
  evalConsole,
  evalAnimation,
  evalSignal,
  evalSettled,
  type Predicate,
  type EvalResult,
} from './predicate-eval.js';

export { PredicateSchema };
export type { Predicate, EvalResult };

/** The subset of Session the predicate engine needs — keeps it testable with a fake. */
export interface PredicateSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Milliseconds since connect — the same clock that stamps event `t` (injected, testable). */
  elapsed(): number;
}

async function matchOnce(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
): Promise<MatchResult> {
  const res = await session.command(ReticleCommand.MATCH, { query, state });
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

async function evalState(
  session: PredicateSession,
  p: Extract<Predicate, { kind: 'state' }>,
): Promise<EvalResult> {
  const res = await session.command(
    ReticleCommand.STATE_READ,
    p.store !== undefined ? { store: p.store } : {},
  );
  if (!res.ok) return { pass: false, failureReason: 'state read failed' };
  const stores = ((res.result ?? {}) as { stores?: Record<string, unknown> }).stores ?? {};
  const names = Object.keys(stores);
  const storeName = p.store ?? (names.length === 1 ? names[0] : undefined);
  if (storeName === undefined) {
    return {
      pass: false,
      failureReason:
        names.length === 0
          ? 'no registered store to read state from'
          : `multiple stores (${names.join(', ')}); name one with \`store\``,
    };
  }
  const selection = selectPath(stores[storeName], p.path);
  if (!selection.found) {
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in store '${storeName}'`,
      evidence: { availableKeys: selection.availableKeys },
    };
  }
  const want = p.equals === undefined ? '*' : p.equals;
  if (matchValue(selection.value, want)) {
    return {
      pass: true,
      evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
    };
  }
  return {
    pass: false,
    failureReason: `state '${p.path}' is ${JSON.stringify(capDepth(selection.value, 0))}, expected ${JSON.stringify(want)}`,
    evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
  };
}

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
    case 'state':
      return evalState(session, predicate);
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

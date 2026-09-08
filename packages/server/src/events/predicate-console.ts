/**
 * Console predicates: the assertion agents lean on hardest, and the one with a structural blind spot.
 *
 * Split out of `predicate-eval.ts` when it crossed the file cap. Cohesive on its own terms — the
 * level map, the channel-liveness gate, and the absent/present branches are one subject, and nothing
 * else in the evaluator reads a CONSOLE_* event.
 */

import { CONSOLE_ATTACH_NOTE, EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';
import type { EvalResult } from './predicate-eval.js';
import type { Predicate } from './predicate-schema.js';

/** The only console levels Reticle instruments (console.info/debug/trace are NOT patched). */
const CONSOLE_LEVEL_TYPE: Readonly<Record<string, EventType>> = {
  log: EventType.CONSOLE_LOG,
  warn: EventType.CONSOLE_WARN,
  error: EventType.CONSOLE_ERROR,
};

/**
 * Has the console channel reported ANYTHING in this window, at any level?
 *
 * Liveness, on the same argument `observerSawSubresources` makes for resource timing: one entry
 * anywhere proves the channel reaches this document, so the caller is not looking at a dead read.
 * Any level counts — a `console.log` proves the patch is in place just as well as an error would,
 * and asking only about the ASSERTED level would re-fire the caveat on every quiet window of a
 * chatty page, which is a toll paid where the warning is not true.
 *
 * It does not CLOSE the blind stretch — that is about time before attach and cannot be closed from
 * this side. It only rules out the reading the caveat's wording would get wrong.
 */
function channelReported(events: ReticleEvent[], since: number): boolean {
  return events.some(
    (e) =>
      e.t >= since &&
      (e.type === EventType.CONSOLE_LOG ||
        e.type === EventType.CONSOLE_WARN ||
        e.type === EventType.CONSOLE_ERROR ||
        e.type === EventType.CONSOLE_INFO ||
        e.type === EventType.CONSOLE_DEBUG ||
        e.type === EventType.ERROR_UNCAUGHT),
  );
}

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
  // A text match narrows the population to entries whose captured message contains the substring.
  // With `absent: true` this is the whole point: "THIS message did not appear", not "no messages
  // appeared" — the difference between a regression check and a fragile one that any unrelated
  // warning anywhere in the app breaks.
  const wanted = 'contains' in p ? p.contains : undefined;
  // Captured messages are strings (stringifyArgs in the browser observer), but a malformed or
  // foreign event must not crash the evaluator: non-strings stringify defensively, and objects
  // go through JSON.stringify rather than a default toString that would print '[object Object]'.
  const asText = (v: unknown): string => {
    if ('string' === typeof v) return v;
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '';
    }
  };
  const matching =
    wanted !== undefined
      ? matches.filter((e) => asText(e.data['message']).includes(wanted))
      : matches;
  if (true === p.absent) {
    if (wanted !== undefined && 0 === matching.length && matches.length > 0) {
      // Other entries exist but none carries the substring: exactly the pass an absence-with-match
      // asserts. Name both counts so the caller can tell this from a silent window.
      return {
        pass: true,
        evidence: { absent: true, contains: wanted },
      };
    }
    return 0 === matching.length
      ? {
          pass: true,
          evidence: {
            absent: true,
            // Only when the window starts at attach AND nothing came through at all. An entry
            // anywhere in the window proves the channel reaches this document, which is the case
            // the caveat's wording would misdescribe; a window an action opened has `since > 0` and
            // was fully observed. Costs nothing on every other pass, which is most of them.
            ...(0 === since && !channelReported(events, since)
              ? { unobservedBefore: CONSOLE_ATTACH_NOTE }
              : {}),
          },
        }
      : {
          pass: false,
          failureReason:
            wanted !== undefined
              ? `expected no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)} but found ${String(matching.length)}`
              : `expected no ${p.level ?? 'console'} entries but found ${String(matches.length)}`,
          observed:
            wanted !== undefined
              ? `${String(matching.length)} ${p.level ?? 'console'} entr${1 === matching.length ? 'y' : 'ies'} containing ${JSON.stringify(wanted)}`
              : `${String(matches.length)} ${p.level ?? 'console'} entr${1 === matches.length ? 'y' : 'ies'}`,
          expected:
            wanted !== undefined
              ? `no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)}`
              : `no ${p.level ?? 'console'} entries`,
          assertion: wanted !== undefined ? 'console.absent-contains' : 'console.absent',
          evidence: matching.map((e) => e.data),
        };
  }
  return matching.length > 0
    ? { pass: true, evidence: matching.map((e) => e.data) }
    : {
        pass: false,
        failureReason:
          wanted !== undefined
            ? `no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)} found`
            : `no ${p.level ?? 'console'} entries found`,
        observed:
          wanted !== undefined
            ? `no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)} in the window`
            : `no ${p.level ?? 'console'} entries in the window`,
        expected:
          wanted !== undefined
            ? `at least one ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)}`
            : `at least one ${p.level ?? 'console'} entry`,
        assertion: 'console.present',
      };
}

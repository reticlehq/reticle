/**
 * Say each instrumentation gap's REMEDY once per session; keep its facts every time.
 *
 * `instrumentation-gap.ts` sets the rule this enforces: a gap fires only when an absence in the app
 * changed the answer the agent just got, "never as a survey of everything uninstrumented on the
 * page". The vocabulary honoured that. The emission did not — the same remedy shipped on every
 * verdict that hit the same absence.
 *
 * Measured on a 61-call drive of a production-sized dashboard fixture: `no-source-mapping` was
 * emitted **11 times, byte-identical, 365 B each**, and `instrumentationGaps` as a whole was 11.5%
 * of the run's entire token cost, of which 17 occurrences were repeats of advice already given.
 *
 * The two halves have different shelf lives:
 *   - `missing` / `cost` / `fix` — the REMEDY. Identical every time. Teaches once, then it is rent.
 *   - `ref` / `source` — the FACTS. Different per element, and the reason a repeat is worth sending
 *     at all: "this control too" is news; "here is what source mapping is" is not.
 *
 * So a repeat keeps the facts, drops the prose, and carries `repeat: true` so a reader knows the
 * full text was given earlier in this session rather than withheld.
 *
 * Scoped per session id, because a new session is a new agent that has been told nothing.
 */

/** The fields worth repeating. Everything else on a gap is the remedy, said once. */
const FACT_KEYS = ['kind', 'ref', 'source'] as const;

/** Sessions that have already been given the full text, by gap kind. */
const toldBySession = new Map<string, Set<string>>();

/** Just enough shape to route on. Deliberately NOT an index signature: `InstrumentationGap` is a
 *  union of concrete object types and would not be assignable to one. */
interface GapLike {
  kind?: unknown;
}

/**
 * Full text the first time a kind is seen in this session; facts-only afterwards.
 *
 * Returns a NEW array and never mutates its input — the same gap objects travel into telemetry and
 * into the persisted capsule, and trimming those would lose the remedy where it is read cold.
 */
export function withGapNovelty<T extends GapLike>(
  sessionId: string | undefined,
  gaps: readonly T[],
): T[] {
  if (0 === gaps.length) return [];
  // No session id means no memory to check against, so nothing can be a repeat. Sending the full
  // text is the safe direction: a reader who has seen it skims, a reader who has not is stuck.
  if (sessionId === undefined) return [...gaps];
  let told = toldBySession.get(sessionId);
  if (told === undefined) {
    told = new Set<string>();
    toldBySession.set(sessionId, told);
  }
  return gaps.map((gap) => {
    const kind = 'string' === typeof gap.kind ? gap.kind : undefined;
    if (kind === undefined) return gap;
    if (!told.has(kind)) {
      told.add(kind);
      return gap;
    }
    const source = gap as unknown as Record<string, unknown>;
    const compact: Record<string, unknown> = { repeat: true };
    for (const key of FACT_KEYS) {
      if (source[key] !== undefined) compact[key] = source[key];
    }
    return compact as unknown as T;
  });
}

/** Forget a session. Called when a session ends so a long-lived daemon does not grow a map forever. */
export function forgetGapNovelty(sessionId: string): void {
  toldBySession.delete(sessionId);
}

/** Test seam: drop every session's memory. */
export function resetGapNovelty(): void {
  toldBySession.clear();
}

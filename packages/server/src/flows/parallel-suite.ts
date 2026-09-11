/**
 * Parallel suite execution. `flow_verify` replays flows sequentially because they all drive the
 * SAME live tab and would race the DOM. The escape is the lease pool: each flow gets its own isolated
 * headless context, so N flows can run at once and a 200-flow suite finishes in interactive time.
 *
 * This is the scheduler half — a bounded-concurrency map, kept pure and injectable so the ordering and
 * failure semantics are unit-tested without a browser:
 * - results come back in INPUT order regardless of completion order (a suite verdict must be stable),
 * - one flow throwing never sinks the run — it is captured as that item's outcome, because a suite that
 * aborts on the first crash tells you nothing about the other 199 flows.
 */

export interface Outcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Order-preserving; per-item failures are captured
 * rather than thrown. `limit` is clamped to at least 1 (a 0/negative cap would deadlock the suite).
 */
export async function mapWithConcurrency<I, T>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<T>,
): Promise<Outcome<T>[]> {
  const results: Outcome<T>[] = new Array<Outcome<T>>(items.length);
  const cap = Math.max(1, Math.floor(limit));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      try {
        results[index] = { ok: true, value: await fn(item, index) };
      } catch (error) {
        results[index] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()));
  return results;
}

/**
 * How many flows to run at once: never more than there are flows, never more than the pool can lease,
 * and never below 1. Explicit `requested` (the tool's `parallel` arg) wins when it is a sane number.
 */
export function resolveConcurrency(
  flowCount: number,
  poolCapacity: number,
  requested?: number,
): number {
  const ceiling = Math.max(1, Math.min(flowCount, poolCapacity));
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return ceiling;
  return Math.max(1, Math.min(Math.floor(requested), ceiling));
}

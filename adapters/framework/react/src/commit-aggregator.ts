/**
 * Throttled commit aggregator (render stream). React can commit many times per frame; emitting a
 * RENDER_COMMIT event per commit would flood the ledger. This accumulates commits and flushes the COUNT
 * once per throttle window (a scheduled tick), so a commit storm shows up as one event carrying its
 * magnitude. The scheduler is injected, keeping the accumulate/flush logic pure and unit-testable.
 */
export interface CommitAggregator {
  onCommit(): void;
}

interface CommitAggregatorOptions {
  /** Injected scheduler (rAF / setTimeout) — deterministic in tests. */
  schedule: (fn: () => void) => void;
  /** Called once per window with the number of commits accumulated since the last flush. */
  flush: (commits: number) => void;
}

export function createCommitAggregator(options: CommitAggregatorOptions): CommitAggregator {
  let pending = 0;
  let scheduled = false;
  return {
    onCommit(): void {
      pending += 1;
      if (scheduled) return;
      scheduled = true;
      options.schedule(() => {
        scheduled = false;
        const commits = pending;
        pending = 0;
        if (commits > 0) options.flush(commits);
      });
    },
  };
}

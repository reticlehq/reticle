/**
 * Debounce batcher for `reticle watch` — a save-heavy editor fires many change events per real edit
 * (temp files, multi-file formats-on-save). This coalesces a burst of changed paths into one flush after
 * a quiet window, so we compute affected flows once per edit, not per keystroke. The scheduler (setTimeout)
 * is injected, keeping the batching logic pure and unit-testable.
 */
interface WatchBatcher {
  onChange(file: string): void;
}

interface WatchBatcherOptions {
  debounceMs: number;
  /** Injected scheduler (setTimeout) — deterministic in tests. */
  schedule: (fn: () => void, ms: number) => void;
  /** Called once per quiet window with the unique changed paths since the last flush. */
  onFlush: (files: string[]) => void;
}

export function createWatchBatcher(options: WatchBatcherOptions): WatchBatcher {
  let pending = new Set<string>();
  let scheduled = false;
  return {
    onChange(file: string): void {
      pending.add(file);
      if (scheduled) return;
      scheduled = true;
      options.schedule(() => {
        scheduled = false;
        const files = [...pending];
        pending = new Set();
        if (files.length > 0) options.onFlush(files);
      }, options.debounceMs);
    },
  };
}

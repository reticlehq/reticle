/**
 * Serialize read-modify-write against a single file across the whole daemon process.
 *
 * Several paths — most importantly `reticle_flow_verify parallel:N` — run load→mutate→save against the
 * SAME shared JSON file (project.json run history, assertion-tiers.json anti-gaming baseline,
 * envelopes.json deviation baselines) from concurrently-scheduled async tasks. With no lock, two tasks
 * read the same base, each appends its own record, and the later save clobbers the earlier's mutation —
 * a silent lost update. For the run history that undercounts the suite; for the assertion-tiers baseline
 * the anti-reward-hacking gate silently loses coverage (fails open).
 *
 * Keyed by ABSOLUTE PATH, not by store instance, because some callers construct a fresh store per flow
 * pointed at the same file (an instance mutex would not serialize those). One process owns the file, so
 * a module-level chain per path is the correct serialization boundary.
 */
const chains = new Map<string, Promise<unknown>>();

export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  // Run after the previous holder settles, regardless of whether it resolved or rejected.
  const run = prev.then(fn, fn);
  // Keep the chain alive but swallow the outcome so one task's rejection never rejects the next waiter.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(path, settled);
  // Reclaim the entry once settled IF no successor queued behind us (the Map still points to our
  // promise). Without this, every unique path leaks a Map slot for the daemon's lifetime.
  void settled.then(() => {
    if (chains.get(path) === settled) chains.delete(path);
  });
  return run;
}

/** Exposed for testing — returns the number of active chain entries. */
export function chainSize(): number {
  return chains.size;
}

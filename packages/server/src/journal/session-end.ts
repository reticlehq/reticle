import { AmbientStore } from './ambient-store.js';
import type { AmbientCounts } from './ambient.js';
import type { FileSystemPort } from '../project/fs-port.js';
import { pruneSessions } from './retention.js';

/**
 * Session teardown: the durable half of ending a session. Two things must happen when a tab disconnects,
 * and neither did before — the journal batches events and only writes at its flush threshold, so the tail
 * of every session (< one batch) was silently lost from disk, and the learned ambient map was never
 * persisted at all, so every session re-learned the page's churn from zero.
 *
 * Both are best-effort: a teardown failure must never surface as a session error (the tab is already gone).
 */

/** The minimal Session surface teardown needs (Session satisfies it structurally). */
export interface SessionEndTarget {
  readonly id: string;
  /** Write any batched journal events to disk. */
  flushJournal(): Promise<void>;
  /** The ambient-churn counts learned during this session. */
  ambientCounts(): AmbientCounts;
  ownAmbientCounts(): AmbientCounts;
}

interface SessionEndDeps {
  fs: FileSystemPort;
  reticleRoot: string;
  /** Journaling/persistence off (opt-out) → teardown is a no-op. */
  enabled: boolean;
}

/**
 * Build the teardown handler the bridge fires when a session is removed. Flushes the journal first (so no
 * evidence is lost), then folds this session's ambient counts into the persisted map so the NEXT session
 * starts already knowing which regions churn.
 */
export function makeSessionEnd(deps: SessionEndDeps): (session: SessionEndTarget) => Promise<void> {
  return async (session) => {
    if (!deps.enabled) return;
    try {
      await session.flushJournal();
    } catch {
      // a failed flush must not block ambient persistence, and must never throw at teardown
    }
    try {
      const store = new AmbientStore(deps.fs, deps.reticleRoot);
      const persisted = await store.load();
      // Accumulate history + what is NEW. `ownAmbientCounts` excludes the map this session was
      // seeded from at startup; `ambientCounts` includes it, and adding that onto `persisted` wrote
      // `2 x persisted + own` on every teardown — a doubling per session that had driven the
      // committed map to ~9.1e23.
      const merged: AmbientCounts = { ...persisted };
      for (const [ref, count] of Object.entries(session.ownAmbientCounts())) {
        merged[ref] = (merged[ref] ?? 0) + count;
      }
      await store.save(merged);
    } catch {
      // ambient learning is an optimization; a disk failure never breaks teardown
    }
    try {
      // Bound the journal on disk HERE, not only at daemon start.
      //
      // Pruning ran exactly once, during wiring. A daemon that stays up — which is the normal case for
      // a dev session, and the whole point of the pool — therefore never pruned again, so session
      // directories accumulated without bound for as long as it lived. Session end is the right moment
      // because it is precisely when a new directory has just been created, which makes this amortized
      // rather than periodic (no timer to leak) and mirrors what RunStore already does.
      //
      // Safe against deleting the session that just ended: pruning selects the OLDEST by mtime, and the
      // directory written moments ago is the newest.
      await pruneSessions(deps.fs, deps.reticleRoot);
    } catch {
      // retention is best-effort maintenance; never surface at teardown
    }
  };
}

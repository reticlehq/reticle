import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import type { KeepCallerContextFn, NoteFn } from '@/window/engine-host.js';
import type { AmbientCounts } from '@/window/ambient.js';

/**
 * What the predicate engine needs from a session, and nothing more.
 *
 * A leaf: `predicate-element.ts` is called BY `predicate.ts` and had to import this back out of it
 * just to declare its own parameter. The subset is what makes the engine testable with a fake, and a
 * fake should not have to load the evaluator to be written.
 */
/** The subset of Session the predicate engine needs — keeps it testable with a fake. */
export interface PredicateSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Hold this wait's window against eviction while it is graded; returns the release (#668). */
  protectWindow?(cursor: number): () => void;
  /** Milliseconds since connect — the same clock that stamps event `t` (injected, testable). */
  elapsed(): number;
  /**
   * Where the app is RIGHT NOW — the session's live URL, kept current across SPA navigation.
   *
   * Read by the `route` predicate when the window holds no route change, which is the only way
   * "did the session survive a reload?" can be answered at all. Optional: a fake session that never
   * navigates simply omits it and route falls back to change-only, as before.
   */
  url?: string;
  /**
   * The document currently under observation, as the session derived it from its own event stream.
   *
   * Every oracle below that reads the window asks "what happened here", and a window is scoped by
   * time and by ring-buffer capacity and by nothing else — so it can still hold the traffic, console
   * output and signals of a page a full navigation or a reload has already thrown away. Answering a
   * predicate with one of those is true about the bytes and false about the world, in whichever
   * direction it lands: a stale event that satisfies the assertion is a false green, and one that
   * refutes it is a false red.
   *
   * Optional, and undefined means nobody could say which document is current — `isSameDocument`
   * treats absence as current on both sides, so the engine then behaves exactly as it did before this
   * existed. Named to match `Session.currentDocumentId`, which is what supplies it in production.
   */
  currentDocumentId?: string | undefined;
  /**
   * Learned per-ref ambient-churn counts (real-time regions that churn with no action driving them).
   * The settle oracle drops events on learned-ambient refs so a chat/ticker page can still go quiet.
   * Optional: a session without ambient learning simply omits it and settle behaves as before.
   */
  ambientCounts?(): AmbientCounts;
  /**
   * Subscribe to session disconnect. Returns an unsubscribe function. Optional: a session without
   * this hook (e.g. tests that never disconnect) simply leaves in-flight predicates until timeout.
   */
  onDisconnect?(listener: () => void): () => void;
  /**
   * True when the tab is hidden or stale enough that the browser is throttling it.
   * Optional: a fake that never throttles simply omits it.
   */
  throttled?(): boolean;
  /** Precondition failure reason (e.g. seedStorage), if any. */
  preconditionFailure?(): string | undefined;
  /**
   * Somewhere to record a wait that could not be run at all. See engine-host.ts.
   *
   * Optional: a fake that omits it loses the note and nothing else. The daemon's own session
   * supplies it, and `engine-host-is-supplied.test.ts` is what stops that quietly going away.
   */
  note?: NoteFn;
  /**
   * Keeps a re-check attached to the call that started the wait. See engine-host.ts.
   *
   * Optional: a fake that omits it gets its callback back unchanged.
   */
  keepCallerContext?: KeepCallerContextFn;
}

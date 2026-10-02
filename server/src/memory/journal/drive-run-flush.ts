/**
 * Publish a drive's evidence while the drive is still happening.
 *
 * The run artifact a drive's verdicts live in used to be written by session TEARDOWN and nowhere
 * else, and the sync daemon can only push artifacts that exist — so the dashboard showed nothing
 * until the tab closed, and a dashboard that is correct only after you stop working is one nobody
 * looks at while working. (`drive-run.ts` fixed the step before this: a live drive produced no
 * artifact at all, because only flow replay wrote one.)
 *
 * SAFE TO CALL REPEATEDLY, not a second writer racing the first. `recordDriveRun` derives its run id
 * from the SESSION (`driveRunId(session.id)`) so a tab that reconnects appends to the same ledger,
 * which makes the write idempotent: the same session rewrites its own run and the cloud supersedes
 * by run id.
 *
 * DEBOUNCED, because the fold reads the whole journal and rewrites the whole artifact, so doing it
 * per verdict would make a fast drive quadratic in its own length. The value is "current within
 * seconds", not "within microseconds".
 *
 * Teardown still flushes, and must: the debounce may have a write pending when the tab closes, and
 * the last verdicts of a session are the ones somebody is waiting on.
 */

import { HookEvent, type HookPayload } from '@reticlehq/core/hooks';
import { onHook } from '@/hooks/hook-bus.js';
import { log } from '@/log.js';

/** Long enough to collapse a burst of verdicts, short enough that a human reads it as "live". */
const FLUSH_DEBOUNCE_MS = 3_000;

/** Only what a flush needs. The real Session satisfies it structurally, as everywhere else here. */
export interface FlushableSession {
  readonly id: string;
}

export interface DriveRunFlushDeps<S extends FlushableSession> {
  /** Find the live session a verdict came from, or undefined when it has already gone. */
  resolve: (sessionId: string) => S | undefined;
  /** Write this session's run artifact. The same call teardown makes. */
  write: (session: S) => Promise<void>;
  /** Injected so the test does not wait three real seconds. */
  debounceMs?: number;
}

/**
 * Flush a session's run shortly after each verdict, coalescing bursts.
 *
 * Returns a handle so a caller can flush a session immediately (teardown does) and stop the timers.
 */
export function attachDriveRunFlush<S extends FlushableSession>(
  deps: DriveRunFlushDeps<S>,
): { flushNow: (sessionId: string) => Promise<void>; stop: () => void } {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const wait = deps.debounceMs ?? FLUSH_DEBOUNCE_MS;
  /** Reported once per distinct failure: a disk that cannot be written says so, not every verdict. */
  const reported = new Set<string>();

  const flush = async (sessionId: string): Promise<void> => {
    const timer = pending.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pending.delete(sessionId);
    }
    const session = deps.resolve(sessionId);
    // Gone already. Teardown owns the final write, so there is nothing to rescue and nothing wrong.
    if (session === undefined) return;
    try {
      await deps.write(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reported.has(message)) return;
      reported.add(message);
      log(`drive run flush failed: ${message}`);
    }
  };

  const off = onHook(HookEvent.VERDICT, (payload: HookPayload) => {
    const sessionId = 'sessionId' in payload ? payload.sessionId : undefined;
    if (sessionId === undefined) return;
    const existing = pending.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      void flush(sessionId);
    }, wait);
    // The daemon must be able to exit with a flush pending. This is a nicety on a timer, not an
    // obligation, and holding the process open for it would make `reticle` feel broken on exit.
    timer.unref?.();
    pending.set(sessionId, timer);
  });

  return {
    flushNow: flush,
    stop: (): void => {
      off();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

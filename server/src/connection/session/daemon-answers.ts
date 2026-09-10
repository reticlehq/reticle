import { log } from '../../log.js';
import { bindSpanContext } from '../../trace.js';

/**
 * What the daemon answers when the rules that decide a verdict ask it for something.
 *
 * The rules are meant to be liftable out of the daemon on their own, so they never go looking for
 * the log or the tracer -- both are handed to them, on the session object they are already given.
 * See `events/engine-host.ts` for why, and for what happens when nobody answers.
 *
 * They live here rather than inside the session class because neither is anything to do with a
 * particular browser tab. They are the daemon's own identity, and every session gives the same
 * answer.
 */

/** Write something down where the daemon writes everything else. */
export const noteToDaemonLog = log;

/**
 * Keep a callback belonging to the call that created it, so a re-check scheduled for later still
 * traces back to the wait that asked for it instead of looking like work starting from nowhere.
 */
export const keepCallerContextInDaemon = bindSpanContext;

/**
 * The two things the rules cannot do for themselves.
 *
 * The rules read what happened and say whether the declared consequence held. They are meant to be
 * liftable out of the daemon on their own, so anyone implementing the specification can have the
 * rules without also taking a web socket, a command line and somewhere to put the answer.
 *
 * Two ordinary needs stand in the way of that. When a rule cannot be run at all, somebody should be
 * told; and when a rule schedules a re-check for later, that re-check should still look like part of
 * the call that asked for it, rather than an orphan nobody can trace back.
 *
 * Both are answered by whoever is running the rules, not by the rules going and finding the daemon.
 * This is the same arrangement the project scaffolder uses: anything it cannot know for itself is
 * handed to it, and a new outward need is a new member here rather than a new import.
 *
 * Both are optional everywhere they appear. Leave them out -- as a test with a fake usually does --
 * and nothing is recorded and callbacks run as they always did. That is deliberate: a missing note
 * should cost you a log line, never a verdict.
 */

/**
 * Record something the rules could not do.
 *
 * Example: a rule threw while reading a window, so the wait is ended rather than left pending, and
 * `note('reticle_wait_failed', { predicate: 'net', error: 'bad selector' })` says why.
 */
export type NoteFn = (event: string, detail: Record<string, unknown>) => void;

/**
 * Wrap a callback so it still belongs to the call that created it.
 *
 * A wait re-checks itself when a new event arrives or a timer fires. Neither of those is inside the
 * original call, so without this every re-check looked like a brand new piece of work starting from
 * nowhere. On one healthy run that produced twenty-three of them, which is exactly what a genuinely
 * stuck call looks like -- so the thing meant to spot trouble was manufacturing it.
 */
export type KeepCallerContextFn = (callback: () => void) => () => void;

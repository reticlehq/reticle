/**
 * Whether a command in flight may be re-issued against the connection that REPLACED this session,
 * and how far a chain of replacements is worth walking.
 *
 * One question, so one file. It left `session.ts` when that file crossed the thousand-line cap on a
 * merge: two branches had each grown it by a few lines and the sum went over, which is the moment
 * the rule says to split rather than to raise the number. These two constants and the reasoning
 * behind them are the most self-contained thing in there — `session.ts` reads them twice and owns
 * nothing else about rebinding.
 */
import { ReticleCommand } from '@reticlehq/core';

/**
 * Commands that may be re-issued against the connection that replaced this session.
 *
 * Reads only, and the boundary is the point. Re-reading a page costs nothing and answers the same
 * question the caller asked. An act cannot be replayed: it may already have been dispatched in the
 * page that went away, and performing it a second time behind the caller's back is a double submit
 * nobody asked for. A replaced act still errors, and the caller's own retry — with the same id,
 * which is still the right one — is the safe path.
 */
export const REBINDABLE_COMMANDS: ReadonlySet<string> = new Set<string>([
  ReticleCommand.SNAPSHOT,
  ReticleCommand.QUERY,
  ReticleCommand.MATCH,
  ReticleCommand.INSPECT,
  ReticleCommand.STATE_READ,
  ReticleCommand.STORAGE_READ,
  ReticleCommand.CAPABILITIES,
  ReticleCommand.ANIMATIONS,
]);

/**
 * How far to walk a chain of replacements before giving up.
 *
 * Generous for the real case (a page reloading a handful of times while a call is in flight) and
 * small enough that a cycle costs nothing. The number is a backstop, not a policy: a chain longer
 * than this means something is re-dialling in a loop, and that is a different problem.
 */
export const MAX_SUCCESSOR_HOPS = 32;

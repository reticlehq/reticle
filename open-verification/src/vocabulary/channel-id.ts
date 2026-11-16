/**
 * The channels an observation can come from, and how far each one can be trusted.
 *
 * No zod here: the SDK reads these on the way in, and a module that builds classic zod schemas
 * brings about 85 KB onto every page (#2369).
 */

import type { ChannelDescriptor } from './channel.js';

/**
 * The sources of truth a verdict can be built from.
 *
 * Named for what the thing IS, never for what one surface calls it: a browser console, a phone's
 * log stream and a server's stderr are one channel. A realm with no console still has somewhere
 * errors go.
 *
 * An implementation may observe channels this list does not name, and should declare them with an
 * `x-` prefix. What it may not do is declare two of its own channels independent when one is
 * derived from the other.
 */
export const ChannelId = {
  /** What is on screen and can be pointed at. */
  UI: 'ui',
  /** Requests leaving and answers arriving, across whatever boundary the subject has. */
  NET: 'net',
  /** Application state somebody can read: a store, a model, a view model. */
  STATE: 'state',
  /** Events the application announces about itself. */
  SIGNAL: 'signal',
  /** Where errors and messages go. */
  LOG: 'log',
  /** Where the user is: a URL, a screen, a navigation stack. */
  ROUTE: 'route',
  /** Values that outlive a single screen: cookies, storage, preferences. */
  STORAGE: 'storage',
  /** Time itself: whether things settled, how long something took, what is still in flight. */
  TIME: 'time',
  /** Pixels. Only a surface that renders has this one. */
  VISUAL: 'visual',
} as const;
export type ChannelId = (typeof ChannelId)[keyof typeof ChannelId];

/**
 * May a disagreement between these two channels be reported as a fault in the subject?
 *
 * At least one side must be independent. Two actuation-derived channels disagreeing is the subject
 * contradicting its own reporting -- worth telling somebody, never proof the action failed. Calling
 * it one manufactures the false alarms that make a verdict channel stop being read, which is a
 * slower and more complete failure than any single wrong answer.
 *
 * Two INDEPENDENT channels disagreeing is admissible: a response whose status line says one thing
 * and whose body says another is neither of them derived from the action.
 */
export function disagreementCanConvict(a: ChannelDescriptor, b: ChannelDescriptor): boolean {
  return a.independence === Independence.INDEPENDENT || b.independence === Independence.INDEPENDENT;
}

/** Is this set of channels able to pay for a `yes`? At least one must be consequence-grade. */
export function canProve(channels: readonly ChannelDescriptor[]): boolean {
  return channels.some((c) => c.grade === Grade.CONSEQUENCE);
}

/** Whether a channel can be evidence about the action that produced it. */
export const Independence = {
  /**
   * Produced somewhere the action's own code path does not decide.
   *
   * A request crosses the subject's boundary and another party answers it. An uncaught exception
   * reaches the log stream without the application choosing to report it. What is still in flight
   * is the runtime's accounting, not the application's opinion of itself.
   */
  INDEPENDENT: 'independent',
  /**
   * Produced by the same code path that handled the action.
   *
   * The screen renders from state, state is set by the handler, the signal is fired by the handler,
   * and the pixels are a photograph of the screen. An application that is wrong about what it did
   * is wrong on all of them at once, in agreement -- which is exactly why their agreement proves
   * nothing.
   */
  ACTUATION_DERIVED: 'actuation-derived',
} as const;
export type Independence = (typeof Independence)[keyof typeof Independence];

/**
 * What a channel's evidence is worth.
 *
 * A green paid for with "something matching was on screen" is not the green paid for with "the
 * request went out and the server accepted it", and a report that flattens them lets the cheap
 * evidence pass for the dear evidence. Measured on a deterministic bench: a locator that resolved
 * to the wrong element satisfies a presence check and cannot satisfy a consequence check, which is
 * the entire difference between 1 false green in 88 and 29.
 */
export const Grade = {
  /** The subject provably DID something. Only this grade can buy a `yes`. */
  CONSEQUENCE: 'consequence',
  /** Something was there to see. Real information, and never proof that an action worked. */
  PRESENCE: 'presence',
  /** Useful background that establishes nothing on its own. */
  CONTEXT: 'context',
} as const;
export type Grade = (typeof Grade)[keyof typeof Grade];

/**
 * The independence and grade this specification assigns each channel it names.
 *
 * `Record<ChannelId, ...>` on purpose: a channel added to this protocol does not compile until
 * somebody says whether evidence from it can be trusted about the action that produced it.
 * Answering by omission would answer it the dangerous way.
 *
 * An implementation may report a channel as LESS trustworthy than this table (a `state` channel it
 * reads through the application's own debug endpoint is weaker than one it reads from the store).
 * It may never report one as more.
 */
export const CHANNEL_DEFAULTS: Record<ChannelId, { independence: Independence; grade: Grade }> = {
  [ChannelId.UI]: { independence: Independence.ACTUATION_DERIVED, grade: Grade.PRESENCE },
  [ChannelId.NET]: { independence: Independence.INDEPENDENT, grade: Grade.CONSEQUENCE },
  [ChannelId.STATE]: { independence: Independence.ACTUATION_DERIVED, grade: Grade.CONSEQUENCE },
  [ChannelId.SIGNAL]: { independence: Independence.ACTUATION_DERIVED, grade: Grade.CONSEQUENCE },
  [ChannelId.LOG]: { independence: Independence.INDEPENDENT, grade: Grade.CONTEXT },
  [ChannelId.ROUTE]: { independence: Independence.ACTUATION_DERIVED, grade: Grade.PRESENCE },
  [ChannelId.STORAGE]: { independence: Independence.ACTUATION_DERIVED, grade: Grade.CONSEQUENCE },
  [ChannelId.TIME]: { independence: Independence.INDEPENDENT, grade: Grade.CONTEXT },
  // Pixels are a photograph of what the subject rendered. Observed out of process, CAUSED in
  // process -- and it is the causing that decides this, so a screenshot is not independent
  // evidence about the subject's own claim, however far away the camera is.
  [ChannelId.VISUAL]: { independence: Independence.ACTUATION_DERIVED, grade: Grade.PRESENCE },
};

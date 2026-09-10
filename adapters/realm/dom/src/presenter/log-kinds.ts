/**
 * The names for the kinds of row the in-page panel shows, and how an action row ended.
 *
 * These are four short strings and two more, and they live on their own with nothing imported,
 * because of who needs them. The SDK's entry names them when it tells the panel what is happening --
 * but the panel itself is loaded only once an agent connects, which during ordinary development is
 * almost never. If the names lived with the panel's code, naming one would drag the whole panel into
 * every page load, which is the exact cost being avoided.
 *
 * They are for the panel only. Nothing here crosses the wire, so nothing here has to match anything
 * on the other side.
 */

/** What a row in the panel's log is about. */
export const LOG_KIND = {
  READ: 'read',
  ACT: 'act',
  NARRATION: 'narration',
  HUMAN: 'human',
} as const;
export type LogKind = (typeof LOG_KIND)[keyof typeof LOG_KIND];

/** How an action row ended, which decides the glyph beside it. */
export const LOG_RESULT = { PASS: 'pass', FAIL: 'fail' } as const;
export type LogResult = (typeof LOG_RESULT)[keyof typeof LOG_RESULT];

/**
 * The key an envelope's statistics accumulate under.
 *
 * The envelope map was keyed on the raw `pathname`. On any app whose URLs carry ids — most of them —
 * `/orders/1001` and `/orders/1002` are different keys, so every visit mints a fresh envelope
 * holding one sample.
 *
 * The cost is not the file size. `deviation-report` skips any envelope below
 * `MIN_ENVELOPE_SAMPLES`, so on such an app no envelope ever qualifies, every report answers
 * "envelope too new", and the deviation feature never turns on at all — silently, permanently, with
 * nothing anywhere saying why. The unbounded file and the dead feature are one defect.
 *
 * CONSERVATIVE on purpose. Over-collapsing is the worse error: merging two genuinely different
 * routes builds a baseline from two different pages, and a confident comparison against the wrong
 * population is more expensive than no comparison. So a segment is an id only when it could not
 * plausibly be a route NAME.
 *
 * This is the statistics key alone. The observed path is untouched, because a report has to be able
 * to say "/orders/1001 was slow" — the template tells you where to look, the path tells you what to
 * open.
 */

/** Stands in for any id segment. Not a valid path segment itself, so it cannot collide with one. */
const ID = ':id';

/** 8+ hex characters: a token, a hash, a short uuid. Below that it is as likely to be a word. */
const LONG_HEX = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS = /^\d+$/;

/**
 * A year collapses too, and that is a deliberate trade rather than an oversight: `/reports/2024`
 * and `/reports/2025` are the same page with different data, which is exactly what one envelope
 * should describe. Distinguishing a year from an id needs to know the app, and guessing would
 * reintroduce the split this exists to remove.
 */
function isIdSegment(segment: string): boolean {
  return ALL_DIGITS.test(segment) || UUID.test(segment) || LONG_HEX.test(segment);
}

export function routeTemplate(pathname: string): string {
  if (0 === pathname.length) return pathname;
  return pathname
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ID : segment))
    .join('/');
}

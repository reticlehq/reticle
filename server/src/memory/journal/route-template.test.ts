/**
 * Statistics accumulate per route TEMPLATE, or they never accumulate at all.
 *
 * The envelope map was keyed on the raw `pathname` from the ROUTE_CHANGE event. On any app whose
 * URLs carry ids — which is most of them — `/orders/1001` and `/orders/1002` are two different
 * keys, so every visit mints a fresh envelope with one sample in it.
 *
 * That is not merely growth. `deviation-report` skips any envelope below `MIN_ENVELOPE_SAMPLES`,
 * so on such an app NO envelope ever qualifies, every report answers "envelope too new (need N
 * runs)", and the deviation feature silently never works — for the whole life of the project, with
 * no error anywhere. A file that grows without bound and a feature that never turns on are the same
 * defect here.
 *
 * Collapsing is deliberately CONSERVATIVE. A segment is an id only when it could not plausibly be a
 * route name: all digits, a uuid, or a long hex token. `/v1/orders`, `/2024/report` and `/a/b` keep
 * every segment, because guessing wrong merges two genuinely different routes into one envelope and
 * a baseline built from two different pages is worse than no baseline.
 *
 * The OBSERVED path is not thrown away — this is only the statistics key. A report still names the
 * route the drive was actually on, because "/orders/1001 was slow" is what a reader can act on.
 */

import { describe, expect, it } from 'vitest';
import { routeTemplate } from './route-template.js';

describe('the key statistics accumulate under', () => {
  it('collapses a numeric id so two orders share one envelope', () => {
    expect(routeTemplate('/orders/1001')).toBe(routeTemplate('/orders/1002'));
  });

  it('collapses a uuid', () => {
    expect(routeTemplate('/users/550e8400-e29b-41d4-a716-446655440000')).toBe(
      routeTemplate('/users/6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    );
  });

  it('collapses a long hex token', () => {
    expect(routeTemplate('/session/a1b2c3d4e5f60718')).toBe(
      routeTemplate('/session/0f1e2d3c4b5a6978'),
    );
  });

  it('keeps a static route exactly as it is', () => {
    expect(routeTemplate('/diagnostics')).toBe('/diagnostics');
  });

  it('keeps the root', () => {
    expect(routeTemplate('/')).toBe('/');
  });

  /** The conservative half. Over-collapsing merges two real routes into one baseline. */
  it('does not collapse a version segment', () => {
    expect(routeTemplate('/v1/orders')).toBe('/v1/orders');
  });

  it('does not collapse short words that merely look cryptic', () => {
    expect(routeTemplate('/a/b')).toBe('/a/b');
  });

  it('does not collapse a slug', () => {
    expect(routeTemplate('/posts/why-we-ship')).toBe('/posts/why-we-ship');
  });

  it('collapses every id segment, not just the first', () => {
    expect(routeTemplate('/orders/1001/items/42')).toBe(routeTemplate('/orders/7/items/9'));
  });

  it('keeps two genuinely different routes apart', () => {
    expect(routeTemplate('/orders/1001')).not.toBe(routeTemplate('/invoices/1001'));
  });

  /** A year is all digits and IS an id by this rule — stated so the trade is visible, not implied. */
  it('collapses a numeric segment even when it reads like a year', () => {
    expect(routeTemplate('/reports/2024')).toBe(routeTemplate('/reports/2025'));
  });
});

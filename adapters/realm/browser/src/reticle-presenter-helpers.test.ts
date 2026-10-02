/**
 * The line a human reads in the HUD while an agent drives.
 *
 * Every lookup rendered `Finding [testid=]`, with nothing in the brackets, over and over. Seen in a
 * screenshot of a real drive against bench-app: eight identical rows, none of which said what was
 * being looked for. The log is the only window a person has onto what the agent is doing, and it was
 * saying nothing.
 *
 * One cause behind all of it. `str()` takes a `fallback = ''` and so NEVER returns `undefined` —
 * every `?? ` after it is dead, and every `!== undefined` after it is always true. So the first
 * branch always won: `[testid=]` for any query without a literal `testid`, and the name/role/text
 * fallbacks underneath could not be reached at all.
 */
import { describe, expect, it } from 'vitest';
import { ReticleCommand, QueryBy } from '@reticlehq/core';
import { presentStatus } from './reticle-presenter-helpers.js';

describe('the status line names what is actually being looked for', () => {
  it('shows a testid when the query carries one', () => {
    expect(presentStatus(ReticleCommand.QUERY, { testid: 'row-3700' })).toBe(
      'Finding [testid=row-3700]',
    );
  });

  // The `by`/`value` spelling of the same thing, which the first branch was swallowing.
  it('shows a testid given in the by/value form', () => {
    expect(presentStatus(ReticleCommand.QUERY, { by: QueryBy.TESTID, value: 'row-42' })).toBe(
      'Finding [testid=row-42]',
    );
  });

  /*
   * The fallbacks below the testid branch, which were unreachable.
   *
   * `str(q['testid'])` returned '' for a query with no testid, '' is not nullish, so the `??` never
   * ran and `testid !== undefined` was always true. Everything here rendered as `[testid=]`.
   */
  it('falls back to the role, name and text a query actually used', () => {
    expect(presentStatus(ReticleCommand.QUERY, { role: 'button' })).toBe('Finding "button"');
    expect(presentStatus(ReticleCommand.QUERY, { name: 'Sign in' })).toBe('Finding "Sign in"');
    expect(presentStatus(ReticleCommand.QUERY, { text: 'Saved', name: 'toast' })).toBe(
      'Finding "Saved" (toast)',
    );
  });

  // The one the screenshot caught: nothing to name, so say so rather than printing empty brackets.
  it('says "an element" rather than an empty bracket when the query names nothing', () => {
    expect(presentStatus(ReticleCommand.QUERY, {})).toBe('Finding an element');
    expect(presentStatus(ReticleCommand.MATCH, { query: {} })).toBe('Finding an element');
  });

  it('reads a match query out of its nested field', () => {
    expect(presentStatus(ReticleCommand.MATCH, { query: { testid: 'cmdk-open' } })).toBe(
      'Finding [testid=cmdk-open]',
    );
  });

  // The same dead check twice more: an absent ref rendered "Inspecting " with a trailing space, and
  // an absent store "Reading state: " with nothing after the colon.
  it('falls back to the bare verb when there is no ref or store to name', () => {
    expect(presentStatus(ReticleCommand.INSPECT, {})).toBe('Inspecting an element');
    expect(presentStatus(ReticleCommand.STATE_READ, {})).toBe('Reading state');
  });

  it('still names the store when there is one', () => {
    expect(presentStatus(ReticleCommand.STATE_READ, { store: 'app' })).toBe('Reading state: app');
  });
});

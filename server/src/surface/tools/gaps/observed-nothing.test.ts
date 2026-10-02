/**
 * "Worked, found nothing" and "did not work" looked identical on seven tools.
 *
 * Reported from a field sweep: `network` returned 0 calls, `console` 0 logs, `reconcile` compared 0,
 * `coverage` 0 exercised, `crawl` 0 steps, and `session { messages | review }` empty — with nothing
 * on any of them saying whether the observation had actually happened. A quiet page and a dead
 * observer produce the same JSON, so an agent cannot tell "this app made no requests" from "Reticle
 * is not seeing requests", and those need opposite responses.
 *
 * The fix is not a new field per tool but one shared shape: an empty read states the WINDOW it
 * looked at. A result that says "I watched 2000ms and saw nothing" is a finding; one that just says
 * `[]` is an absence of information wearing the same clothes.
 */

import { describe, expect, it } from 'vitest';
import { noteEmptyRead } from './observed-nothing.js';

describe('an empty read says it looked', () => {
  it('adds a note when the collection is empty', () => {
    const out = noteEmptyRead({ entries: [] }, 'entries', {
      windowMs: 2000,
      noun: 'console lines',
    });
    expect(out['observed']).toBe(true);
    expect(String(out['note'])).toContain('2000');
    expect(String(out['note'])).toContain('console lines');
  });

  it('says nothing when there IS something — the data speaks for itself', () => {
    const out = noteEmptyRead({ entries: [{ text: 'x' }] }, 'entries', {
      windowMs: 2000,
      noun: 'console lines',
    });
    expect(out['observed']).toBeUndefined();
    expect(out['note']).toBeUndefined();
  });

  it('leaves a refusal alone — an error already explains itself', () => {
    // Adding "I observed nothing" to "no browser session connected" would be actively misleading.
    const refusal = { error: 'no browser session connected' };
    expect(noteEmptyRead(refusal, 'entries', { windowMs: 2000, noun: 'console lines' })).toEqual(
      refusal,
    );
  });

  it('does not invent a window it does not have', () => {
    const out = noteEmptyRead({ items: [] }, 'items', { noun: 'flows' });
    expect(out['observed']).toBe(true);
    expect(String(out['note'])).toContain('flows');
    expect(String(out['note'])).not.toContain('undefined');
  });

  it('never overwrites a note the tool already wrote', () => {
    const out = noteEmptyRead({ items: [], note: 'mine' }, 'items', { noun: 'flows' });
    expect(out['note']).toBe('mine');
  });

  it('ignores a key that is not an array, rather than guessing', () => {
    const out = noteEmptyRead({ items: 3 }, 'items', { noun: 'flows' });
    expect(out['observed']).toBeUndefined();
  });
});

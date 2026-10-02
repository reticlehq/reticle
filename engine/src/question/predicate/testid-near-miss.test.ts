/**
 * A failed testid assertion was a dead end, while the same failure through `reticle_query` was not.
 *
 * `reticle_query { testid: 'deploy-tabel' }` on a miss returns `hint.presentTestids` — the testids
 * that ARE on the page — so a one-character typo is instantly recoverable. The identical failure
 * through `reticle_act_and_wait { until: { kind:'element', query:{ testid } } }` said only:
 *
 *     no element matched {"testid":"deploy-tabel"} in state 'visible'
 *
 * and stopped. Driven live: nothing in the result named `deploy-table`, one character away.
 *
 * The near-miss machinery already existed for two cases — an element in the wrong STATE, and a
 * wrong NAME for a role (which even lists the names it saw). Testid, the anchor this codebase calls
 * the gold standard, had none.
 *
 * That matters more now than it did yesterday: adding act_and_wait to the verification path means
 * agents will assert far more, so a failed element assertion becomes the highest-traffic failure in
 * the product. Making it recoverable is worth one extra round trip on a path that has already failed.
 */

import { describe, expect, it } from 'vitest';
import { describeTestidMiss } from './testid-near-miss.js';

describe('describeTestidMiss', () => {
  it('names the testids that ARE present, so a typo is one step from fixed', () => {
    const text = describeTestidMiss('deploy-tabel', ['deploy-table', 'nav-overview']);
    expect(text).toContain('deploy-table');
    expect(text).toContain('nav-overview');
  });

  it('says nothing when the page has no testids at all — there is no hint to give', () => {
    expect(describeTestidMiss('x', [])).toBeUndefined();
  });

  it('does not repeat the missing testid back as if it were present', () => {
    const text = describeTestidMiss('deploy-table', ['deploy-table']) ?? '';
    // The queried id being listed means the miss was about STATE, not presence — say nothing here
    // rather than "you asked for X; X is present", which reads as a contradiction.
    expect(text).toBe('');
  });

  it('caps the list so a 400-testid page cannot flood the failure message', () => {
    const many = Array.from({ length: 200 }, (_, i) => `id-${String(i)}`);
    const text = describeTestidMiss('nope', many) ?? '';
    expect(text.length).toBeLessThan(600);
    expect(text).toMatch(/more|…/);
  });
});

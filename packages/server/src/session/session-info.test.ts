/**
 * An empty `title` is the worst answer this projection can give.
 *
 * Measured across three fixtures: two tabs reported "Rowy" and "Next.js Playground"; the astro one
 * reported `""`. `title` is the field an agent and the HUD use to tell tabs apart, and `""` is not
 * `null` — so "we sampled before the page set one" is indistinguishable from "this page is genuinely
 * untitled", and with two such tabs the list is unusable.
 *
 * Sampling later does not fix it. `#hello()` already reads `document.title` at connect time, and a
 * page that sets its title after connect (or never) will still hand us an empty string — a race
 * cannot be won by moving the sample, only narrowed. So the fix is at the projection: never ship the
 * empty string, and let the consumer fall back to `url`, which is in the same record already.
 */

import { describe, expect, it } from 'vitest';
import { buildSessionInfo } from './session-info.js';
import { UNSCRIPTABLE_TAB_RECOMMENDATION } from '@reticlehq/core';

const view = (title: string) => ({
  id: 's1',
  url: 'http://localhost:4321/docs/intro',
  projectId: undefined,
  title,
  adapters: [],
  hasCapabilities: false,
  versionSkew: undefined,
  hidden: false,
  health: () => ({
    lastSeenMs: 10,
    throttled: false,
    focused: true,
    recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
  }),
  staleMs: () => 0,
  pendingMarkCount: () => 0,
});

describe('buildSessionInfo — title', () => {
  it('passes a real title through untouched', () => {
    expect(buildSessionInfo(view('Rowy')).title).toBe('Rowy');
  });

  it('OMITS the field rather than shipping an empty string', () => {
    const info = buildSessionInfo(view(''));
    expect(
      'title' in info,
      '"" cannot be told apart from "genuinely untitled" — omit it and let the reader use url',
    ).toBe(false);
  });

  it('omits a whitespace-only title too — it is as useless as an empty one', () => {
    expect('title' in buildSessionInfo(view('   '))).toBe(false);
  });

  it('still carries url, which is what a reader falls back to', () => {
    expect(buildSessionInfo(view('')).url).toBe('http://localhost:4321/docs/intro');
  });
});

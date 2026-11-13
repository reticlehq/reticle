import { describe, expect, it } from 'vitest';
import { CODE_FETCH_QUIET_MS, trackCodeFetches } from './code-fetch-tracker.js';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('trackCodeFetches', () => {
  it('says the page fetches code while a module request is open', () => {
    const c = clock();
    const tracker = trackCodeFetches(c.now);
    const module = {};
    tracker.started(module, 'script');
    c.advance(12_000);
    expect(tracker.fetching()).toBe(true);
  });

  it('keeps saying so for the quiet time after the last module request ends', () => {
    const c = clock();
    const tracker = trackCodeFetches(c.now);
    const module = {};
    tracker.started(module, 'script');
    tracker.ended(module);
    c.advance(CODE_FETCH_QUIET_MS - 1);
    expect(tracker.fetching()).toBe(true);
    c.advance(1);
    expect(tracker.fetching()).toBe(false);
  });

  it('ignores the app data requests, so a long poll does not count as loading', () => {
    const c = clock();
    const tracker = trackCodeFetches(c.now);
    const poll = {};
    tracker.started(poll, 'fetch');
    tracker.started({}, 'xhr');
    tracker.ended(poll);
    expect(tracker.fetching()).toBe(false);
  });

  it('says nothing is fetched before any request', () => {
    expect(trackCodeFetches(clock().now).fetching()).toBe(false);
  });
});

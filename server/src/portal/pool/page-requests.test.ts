import { describe, expect, it } from 'vitest';
import { REQUEST_QUIET_MS, pageLoadingOrFetching, trackPageRequests } from './page-requests.js';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('trackPageRequests', () => {
  it('says the page fetches while a module request is open', () => {
    const c = clock();
    const tracker = trackPageRequests(c.now);
    const module = {};
    tracker.started(module, 'script');
    c.advance(12_000);
    expect(tracker.fetching()).toBe(true);
  });

  it('keeps saying so for the quiet time after the last request ends', () => {
    const c = clock();
    const tracker = trackPageRequests(c.now);
    const module = {};
    tracker.started(module, 'script');
    tracker.ended(module);
    c.advance(REQUEST_QUIET_MS - 1);
    expect(tracker.fetching()).toBe(true);
    c.advance(1);
    expect(tracker.fetching()).toBe(false);
  });

  /*
   * The gap case: an app awaits its data before it imports the module that dials. While that
   * request is open, no module request is, and the document is `complete`. Only the data request
   * says that the page has not finished loading.
   */
  it('counts an open data request, so a page that awaits its data before the next import still loads', () => {
    const c = clock();
    const tracker = trackPageRequests(c.now);
    const data = {};
    tracker.started(data, 'fetch');
    c.advance(5_000);
    expect(tracker.fetching()).toBe(true);
    tracker.ended(data);
    c.advance(REQUEST_QUIET_MS);
    expect(tracker.fetching()).toBe(false);
  });

  it('ignores a stream that stays open for the life of the page', () => {
    const tracker = trackPageRequests(clock().now);
    tracker.started({}, 'eventsource');
    tracker.started({}, 'websocket');
    expect(tracker.fetching()).toBe(false);
  });

  it('says nothing is fetched before any request', () => {
    expect(trackPageRequests(clock().now).fetching()).toBe(false);
  });
});

describe('pageLoadingOrFetching', () => {
  it('counts a complete document with a request in flight as loading', async () => {
    const page = { fetching: () => true, evaluate: () => Promise.resolve('complete') };
    expect(await pageLoadingOrFetching(page)).toBe(true);
  });

  it('reads a complete document with no request in flight as loaded', async () => {
    const page = { fetching: () => false, evaluate: () => Promise.resolve('complete') };
    expect(await pageLoadingOrFetching(page)).toBe(false);
  });
});

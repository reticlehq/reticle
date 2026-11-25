import { describe, expect, it } from 'vitest';
import {
  REQUEST_QUIET_MS,
  pageLoadingOrFetching,
  requestName,
  trackPageRequests,
} from './page-requests.js';

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

  it('names the oldest request that is still open, by its method and path', () => {
    const tracker = trackPageRequests(clock().now);
    const poll = {};
    const module = {};
    tracker.started(
      poll,
      'fetch',
      requestName('GET', 'http://127.0.0.1:8001/api/poll?token=s3cret'),
    );
    tracker.started(module, 'script', requestName('GET', 'http://127.0.0.1:8001/src/app.js'));
    expect(tracker.openRequest()).toBe('GET /api/poll');
    tracker.ended(poll);
    expect(tracker.openRequest()).toBe('GET /src/app.js');
    tracker.ended(module);
    expect(tracker.openRequest()).toBeUndefined();
  });
});

describe('pageLoadingOrFetching', () => {
  it('counts a complete document with a request in flight as loading, and names it', async () => {
    const page = {
      fetching: () => true,
      openRequest: () => 'GET /src/dial.js',
      evaluate: () => Promise.resolve('complete'),
    };
    expect(await pageLoadingOrFetching(page)).toEqual({
      loading: true,
      openRequest: 'GET /src/dial.js',
    });
  });

  // A guard, not a proof of the fix: it passes on main too. It stops the rule from over-counting.
  it('reads a complete document with no request in flight as loaded', async () => {
    const page = { fetching: () => false, evaluate: () => Promise.resolve('complete') };
    expect(await pageLoadingOrFetching(page)).toEqual({ loading: false });
  });

  /*
   * A failed question is one of two things, and the page says which. A navigation destroyed the
   * context that the question ran in: the next document is loading. Or the page is closed.
   */
  it('counts a failed question on an open page as loading: a navigation is in progress', async () => {
    const page = {
      evaluate: () => Promise.reject(new Error('Execution context was destroyed')),
      isClosed: () => false,
    };
    expect(await pageLoadingOrFetching(page)).toEqual({ loading: true });
  });

  it('counts a failed question on a closed page as loaded', async () => {
    const page = {
      evaluate: () => Promise.reject(new Error('Target page, context or browser has been closed')),
      isClosed: () => true,
    };
    expect(await pageLoadingOrFetching(page)).toEqual({ loading: false });
  });

  it('rejects when the question failed and the page cannot say whether it is closed', async () => {
    const page = { evaluate: () => Promise.reject(new Error('no answer')) };
    await expect(pageLoadingOrFetching(page)).rejects.toThrow('no answer');
  });

  /*
   * A crashed page is not closed, and every question to it fails ("Target crashed"). Read as a
   * navigation, it held replay to the cap with a false reason. It loads nothing.
   */
  it('counts a crashed page as not loading, and says that it crashed', async () => {
    const page = {
      crashed: () => true,
      openRequest: () => 'GET /src/dial.js',
      evaluate: () => Promise.reject(new Error('Target crashed')),
      isClosed: () => false,
    };
    expect(await pageLoadingOrFetching(page)).toEqual({ loading: false, crashed: true });
  });
});

describe('a tracked page whose renderer crashed', () => {
  it('drops its open requests, and stays crashed', () => {
    const tracker = trackPageRequests(clock().now);
    tracker.started({}, 'script', 'GET /src/dial.js');
    tracker.crash();
    expect(tracker.crashed()).toBe(true);
    expect(tracker.openRequest()).toBeUndefined();
  });
});

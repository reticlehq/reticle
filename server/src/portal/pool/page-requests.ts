/**
 * Whether a page still has a request in flight, or one ended a moment ago (#2155).
 *
 * `document.readyState` alone does not say that a page on a dev server is still loading. An app that
 * connects Reticle from a dynamic import has a `complete` document while the dev server still
 * compiles the module that dials. Replay then read the page as loaded and gave up at the step
 * budget. The browser sees the module request that is still open, so it counts.
 *
 * Every request counts, not only the requests for code. An app can await its data before it imports
 * the next module. While that request is open, no module request is, and only the data request says
 * that the page has not finished loading. A stream that stays open for the life of the page does not
 * count, because it never ends.
 *
 * A request that never ends cannot hold a wait forever: each caller has its own cap.
 */

import type { Page } from 'playwright';
import { pageLoading } from './pool-lease.js';
import type { PooledPage } from './pool-contract.js';

/** The request types that stay open for the life of the page, so they do not say it is loading. */
export const STREAM_RESOURCE_TYPES: ReadonlySet<string> = new Set(['eventsource', 'websocket']);

/**
 * How long after the last request ends the page still counts as fetching. A module graph loads as a
 * chain: the browser parses one module, then asks for its imports, and an app reads its data, then
 * imports the next module. This bridges the gap between the end of one request and the start of the
 * next one, which takes milliseconds in Chromium.
 */
export const REQUEST_QUIET_MS = 1_000;

/** The requests of one page. */
export interface PageRequests {
  /**
   * A request started. A stream (see `STREAM_RESOURCE_TYPES`) is ignored. `name` says which request
   * it is, for a person: its method and path.
   */
  started(request: object, resourceType: string, name?: string): void;
  /** A request finished or failed. */
  ended(request: object): void;
  /** Whether a request is open, or one ended less than the quiet time ago. */
  fetching(): boolean;
  /** The name of the oldest request that is still open, or undefined when none is. */
  openRequest(): string | undefined;
}

/** Whether a page is still loading and, when a request keeps it loading, which request. */
export interface PageLoad {
  loading: boolean;
  /** The method and path of the oldest open request, as `GET /src/app.js`. */
  openRequest?: string;
}

/** The name of an open request that was started with no name. */
const UNNAMED_REQUEST = 'a request';

/** A page that is not loading. */
export const PAGE_LOADED: PageLoad = { loading: false };

/**
 * The method and path of a request: no query and no fragment, which can carry a token. The name is
 * shortened on purpose. It only says WHICH request is open; it is not a record of the request.
 */
export function requestName(method: string, url: string): string {
  try {
    return `${method} ${new URL(url).pathname}`;
  } catch {
    return method;
  }
}

export function trackPageRequests(
  now: () => number,
  quietMs: number = REQUEST_QUIET_MS,
): PageRequests {
  // Map, not Set: it keeps the order the requests started in, so the oldest one is named.
  const open = new Map<object, string | undefined>();
  let lastEnded: number | undefined;
  return {
    started(request, resourceType, name) {
      if (!STREAM_RESOURCE_TYPES.has(resourceType)) {
        open.set(request, name);
      }
    },
    ended(request) {
      if (open.delete(request)) {
        lastEnded = now();
      }
    },
    fetching() {
      if (0 < open.size) {
        return true;
      }
      return lastEnded !== undefined && now() - lastEnded < quietMs;
    },
    openRequest() {
      const oldest = open.values().next();
      if (true === oldest.done) {
        return undefined;
      }
      return oldest.value ?? UNNAMED_REQUEST;
    },
  };
}

/**
 * Track the requests of a Playwright page. Attach it before the first navigation, so the requests of
 * the first load count. The page keeps the tracker across its later navigations.
 */
export function watchPageRequests(page: Pick<Page, 'on'>, now: () => number): PageRequests {
  const tracker = trackPageRequests(now);
  page.on('request', (request) => {
    tracker.started(request, request.resourceType(), requestName(request.method(), request.url()));
  });
  page.on('requestfinished', (request) => tracker.ended(request));
  page.on('requestfailed', (request) => tracker.ended(request));
  return tracker;
}

/**
 * Whether the page has not finished loading: a request is in flight, or its document is not
 * complete. The requests come first, because the document can be `complete` while a dev server still
 * compiles a module that the app imports dynamically.
 *
 * When the question to the document fails, the page says which case it is. A closed page loads
 * nothing. An open page is between two documents: a navigation destroyed the context that the
 * question ran in, and the next document is still loading. A page that cannot say rejects.
 */
export async function pageLoadingOrFetching(
  page: Pick<PooledPage, 'fetching' | 'openRequest' | 'evaluate' | 'isClosed'>,
): Promise<PageLoad> {
  const openRequest = page.openRequest?.();
  if (openRequest !== undefined) {
    return { loading: true, openRequest };
  }
  if (true === page.fetching?.()) {
    return { loading: true };
  }
  try {
    return { loading: await pageLoading(page) };
  } catch (error) {
    if (page.isClosed === undefined) {
      throw error;
    }
    return { loading: !page.isClosed() };
  }
}

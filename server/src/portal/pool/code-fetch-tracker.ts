/**
 * Whether a page is still fetching its code: a document, script or stylesheet request is in
 * flight, or one ended a moment ago.
 *
 * `document.readyState` alone does not answer this on a dev server (#2155). An app that connects
 * Reticle from a dynamic import has a `complete` document while the dev server still compiles the
 * module that dials. Replay then read the page as loaded and gave up at the step budget. The browser
 * sees the module request that is still open, so the pool counts it.
 */

import type { Page } from 'playwright';

/** The request types that carry a page's code. A `fetch` or an XHR is the app's data, not its code. */
export const CODE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'document',
  'script',
  'stylesheet',
]);

/**
 * How long after the last code request ends the page still counts as fetching code. A module graph
 * loads as a chain: the browser parses one module, then asks for its imports. This bridges that gap.
 */
export const CODE_FETCH_QUIET_MS = 1_000;

/** The requests of one page that carry its code. */
export interface CodeFetchTracker {
  /** A request started. Requests of other types are ignored. */
  started(request: object, resourceType: string): void;
  /** A request finished or failed. */
  ended(request: object): void;
  /** Whether a code request is open, or one ended less than the quiet time ago. */
  fetching(): boolean;
}

export function trackCodeFetches(
  now: () => number,
  quietMs: number = CODE_FETCH_QUIET_MS,
): CodeFetchTracker {
  const open = new Set<object>();
  let lastEnded: number | undefined;
  return {
    started(request, resourceType) {
      if (CODE_RESOURCE_TYPES.has(resourceType)) {
        open.add(request);
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
  };
}

/**
 * Track the code requests of a Playwright page. Attach it before the first navigation, so the
 * requests of the first load count. The page keeps the tracker across its later navigations.
 */
export function watchCodeFetches(page: Page, now: () => number): CodeFetchTracker {
  const tracker = trackCodeFetches(now);
  // A test fake can have no events. It then fetches nothing, and `readyState` alone answers.
  if ('function' !== typeof (page as Partial<Page>).on) {
    return tracker;
  }
  page.on('request', (request) => tracker.started(request, request.resourceType()));
  page.on('requestfinished', (request) => tracker.ended(request));
  page.on('requestfailed', (request) => tracker.ended(request));
  return tracker;
}

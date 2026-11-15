/**
 * Whether the one tab that a launched provider drives (`reticle verify`, `drive`, `serve --drive`,
 * `mcp --drive`, `@reticlehq/test`) is still loading (#2155).
 *
 * Replay asks this past the step budget, while it waits for the start page to connect. Only a
 * provider that opened the page saw its requests from the first load, so only that provider offers
 * the probe. The rule is the one a pool lease uses: see `pageLoadingOrFetching`.
 */

import type { Page } from 'playwright';
import {
  pageLoadingOrFetching,
  watchPageRequests,
  type PageRequests,
} from '@/portal/pool/page-requests.js';

/** The probe on a real-input provider. */
export interface DrivenLoadingProbe {
  /** Whether the page this provider drives is still loading. Absent: the provider did not open it. */
  drivenPageLoading?(): Promise<boolean>;
}

/** The requests of the driven page, kept from before its first navigation. */
export class DrivenPageLoading {
  readonly #now: () => number;
  #requests: PageRequests | undefined;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Track `page`, the new driven page. Call it before the first navigation. */
  watch(page: Page): void {
    this.#requests = watchPageRequests(page, this.#now);
  }

  /** Whether `page` is still loading. No page, or a page not watched, counts as loaded. */
  loading(page: Page | undefined): Promise<boolean> {
    const requests = this.#requests;
    if (page === undefined || requests === undefined) {
      return Promise.resolve(false);
    }
    return pageLoadingOrFetching({
      fetching: () => requests.fetching(),
      evaluate: (script) => page.evaluate(script),
    });
  }
}

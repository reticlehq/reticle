/**
 * A crawl must walk past a full page load.
 *
 * Reported: `reticle_verify action=crawl` on a server-rendered MPA fails as soon as a link is
 * followed, with "session replaced by a newer connection claiming the same id". A server-rendered
 * page reconnects the SDK on EVERY full page load, so that is the normal consequence of following a
 * link — and crawl treated the rejection of its in-flight click as fatal, so it died on link one.
 *
 * This is not an edge case. It is every non-SPA: Django, Rails, Laravel, plain HTML.
 *
 * The click SUCCEEDED — that is the whole point. The reconnect is the evidence it navigated, so the
 * crawl continues rather than aborting, and the step is recorded as a navigation rather than as a
 * dead control.
 */

import { describe, expect, it } from 'vitest';
import { ReticleCommand } from '@reticlehq/core';
import { crawl } from './crawl.js';
import { sessionReplacedReason } from '../session/session-replaced.js';

/** A page with two links, whose first click reconnects the SDK the way a real page load does. */
function mpaSession(): { session: Parameters<typeof crawl>[0]; clicks: () => number } {
  let clicks = 0;
  const session = {
    command: (name: string) => {
      if (ReticleCommand.SNAPSHOT === name) {
        return Promise.resolve({
          kind: 'command_result',
          id: 's',
          ok: true,
          result: {
            tree: '- link "Products" (ref=e1)\n- link "About" (ref=e2)',
            nodes: 2,
          },
        });
      }
      if (ReticleCommand.ACT === name) {
        clicks += 1;
        // The first click follows a link: the page reloads and the SDK reconnects, so the in-flight
        // command is rejected. A real MPA does this on every navigation.
        if (1 === clicks) {
          return Promise.reject(new Error(sessionReplacedReason('s1', 'http://app/products')));
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'a',
          ok: true,
          result: { dispatched: true },
        });
      }
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    },
    eventsSince: () => [],
    beginAction: () => undefined,
    finishAction: () => undefined,
    elapsed: () => 0,
    url: 'http://app/',
  } as unknown as Parameters<typeof crawl>[0];
  return { session, clicks: () => clicks };
}

describe('crawling a server-rendered app', () => {
  it('does not abort when a click reconnects the SDK', async () => {
    const { session } = mpaSession();
    await expect(crawl(session, { settleMs: 0 }, () => Promise.resolve())).resolves.toBeDefined();
  });

  it('goes on to the next control instead of stopping at the first link', async () => {
    const { session, clicks } = mpaSession();
    await crawl(session, { settleMs: 0 }, () => Promise.resolve());
    expect(clicks(), 'the second link must still be visited').toBeGreaterThan(1);
  });
});

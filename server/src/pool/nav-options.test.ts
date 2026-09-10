/**
 * A leased tab waited for an event some apps never fire, then blamed the app for it.
 *
 * Measured on the sveltekit fixture with RETICLE_TRACE: `reticle_lease` took 30,501ms and failed
 * with "could not open http://localhost:5180/ — is the app running?". The app WAS running. Playwright's
 * `page.goto` defaults to `waitUntil: 'load'`, which waits for every subresource, and that app's page
 * has one that does not finish — so the lease burned its whole 30s nav budget and then reported the
 * one thing that was definitely false.
 *
 * The same trap was fixed twice already in the fixtures harness (verify.mjs, mcp-sweep.mjs), both
 * times with a comment blaming "SvelteKit hangs here". It was never the harness. It is this default,
 * and here it costs a user 30 seconds and a wrong diagnosis on a supported framework.
 *
 * DOMContentLoaded is the right bar and not a weaker one: the SDK connect is a module script, and
 * module scripts run BEFORE DOMContentLoaded fires. The pool then waits for the SDK to register a
 * session anyway (waitForLeasedSession), so the load event was never what proved anything.
 */

import { describe, expect, it } from 'vitest';
import { gotoOptions } from './playwright-launcher.js';

describe('gotoOptions', () => {
  it('never waits for `load` — the event a leased app may never fire', () => {
    expect(gotoOptions(undefined).waitUntil).toBe('domcontentloaded');
    expect(gotoOptions(5000).waitUntil).toBe('domcontentloaded');
  });

  it("passes the pool's nav timeout through when there is one", () => {
    expect(gotoOptions(5000).timeout).toBe(5000);
  });

  /**
   * No timeout means Playwright's own default, not zero. Sending `timeout: 0` would disable the
   * budget entirely and turn a slow page into a lease that never returns — the opposite of the bug.
   */
  it('omits the timeout rather than sending zero when the caller gave none', () => {
    expect(gotoOptions(undefined).timeout).toBeUndefined();
  });
});

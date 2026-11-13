/**
 * `navigate { reload: true }` answered a bare `{ ok: true }`.
 *
 * The URL branch of the same tool returns `confirmed: false` plus a note — because `ok` means the
 * browser accepted the instruction, NOT that the page arrived. The reload branch returned neither,
 * so the one caveat that matters most was missing from the path most likely to need it: the SDK is
 * torn down by the reload and a caller that acts immediately hits the window before it comes back.
 *
 * The permanent session loss reported alongside this is separately fixed (session-continuity.ts
 * remembers the id in sessionStorage so a reload rejoins the same session). What is left is the
 * asymmetry: identical semantics, one branch disclosing them and one not.
 */

import { describe, expect, it } from 'vitest';
import { HardReload, hardReloadOf, reloadResult } from './reload-result.js';

describe('what a reload reports', () => {
  it('is not confirmed — ok means dispatched, and the page has not come back yet', () => {
    const out = reloadResult(false, 5000);
    expect(out.ok).toBe(true);
    expect(out.confirmed).toBe(false);
  });

  it('says what to do about it, in the same terms the URL branch uses', () => {
    // An agent that reads `ok: true` and acts immediately is the failure this prevents.
    expect(String(reloadResult(false, 5000).note)).toContain('reticle_sessions');
  });

  it('names the budget that expired, so "stopped waiting" reads differently from "never came back"', () => {
    expect(reloadResult(false, 5000).waitedMs).toBe(5000);
  });

  it('confirms the reload once the page has re-announced itself', () => {
    // The tool now WAITS for the reconnect (see session-reconnect), so the common case is a
    // confirmed one — and the agent must not be sent to re-select a session that is already live.
    const out = reloadResult(true, 5000);
    expect(out.confirmed).toBe(true);
    expect(String(out.note)).not.toContain('reticle_sessions');
    // Nothing expired, so there is no budget to report.
    expect(out.waitedMs).toBeUndefined();
  });
});

/* #1785: a hard reload says how it reached the page, because only a lease can ignore the cache. */
describe('what a hard reload reports', () => {
  it('names the cache-ignoring reload of a lease, after the reconnect note', () => {
    const out = reloadResult(true, 5000, HardReload.CACHE_IGNORED);
    expect(out.hardReload).toBe(HardReload.CACHE_IGNORED);
    expect(String(out.note)).toContain('re-announced itself');
    expect(String(out.note)).toContain('cache ignored');
  });

  it('says only the document was fetched on a tab that is not a lease', () => {
    const out = reloadResult(false, 5000, HardReload.DOCUMENT_ONLY);
    expect(out.hardReload).toBe(HardReload.DOCUMENT_ONLY);
    expect(String(out.note)).toContain('reticle_sessions');
    expect(String(out.note)).toContain('only the document was fetched again');
  });

  it('adds nothing to a reload that did not ask for hard', () => {
    expect(hardReloadOf(false, false)).toBeUndefined();
    expect(reloadResult(true, 5000, hardReloadOf(false, false))).not.toHaveProperty('hardReload');
  });
});

/**
 * The throttle recommendation has to disclose what its own advice costs.
 *
 * It read: "tab hidden/throttled and may be un-focusable from here; refocus it, or acquire a
 * guaranteed scriptable context yourself with `reticle_lease`". Following the second half moves
 * every later verdict into a pooled context the human CANNOT see — their HUD stays empty for the
 * rest of the run, and the product looks broken while working correctly. The sentence offered that
 * as though it were free.
 *
 * The same report also drove the "throttled" tab successfully afterwards. The flag is not a
 * verdict, and it was being read as one because this sentence answered it with a remedy.
 *
 * Both are wording, and wording is exactly the kind of thing that gets tidied back out. These pin
 * the two disclosures by meaning rather than by quoting the sentence, so it stays editable.
 */
import { describe, expect, it } from 'vitest';
import { UNSCRIPTABLE_TAB_RECOMMENDATION } from './notices.js';

describe('the unscriptable-tab recommendation', () => {
  it('still names both escape hatches', () => {
    // The agent-side one first — an MCP-only agent has no shell, so the CLI is the human's route.
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('reticle_lease');
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('reticle drive');
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('refocus');
  });

  it('says a lease costs the human their view of the run', () => {
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toMatch(/cannot watch|cannot see|CANNOT watch/i);
  });

  it('prefers refocusing when the human is present, rather than leaving the choice unweighted', () => {
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toMatch(/prefer refocusing/i);
  });

  it('says throttled is not proof the tab cannot be driven', () => {
    // Without this the flag reads as a verdict, and the escape hatch gets taken pre-emptively on a
    // tab that would have driven fine.
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toMatch(/does not mean undriveable/i);
  });
});

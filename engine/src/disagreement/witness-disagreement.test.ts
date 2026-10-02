import { describe, expect, it } from 'vitest';
import { witnessDisagreement } from './witness-disagreement.js';

/**
 * The app says it happened. An observer that is not the app says it did not.
 *
 * Every channel a realm declares is, in the end, the subject describing itself: the DOM says the
 * order saved because the app wrote that on the screen, and the network says so because the app
 * made the call. When an app lies to itself — an optimistic update never committed, a write that
 * returned 200 and rolled back — every channel inside it repeats the lie consistently, and no
 * amount of evidence from in there ever settles it. The database is not in there.
 *
 * This is the comparison that uses the outside view. It is deliberately NOT an inference: two
 * independent observers disagreeing is a fact, and nothing else this engine can produce carries the
 * same weight.
 *
 * The asymmetry below is the whole design. A witness that CANNOT be reached proves nothing and must
 * never read as agreement — "I could not check" and "I checked and it was fine" are opposite
 * answers, and collapsing them is how a verification that did not happen gets reported as one that
 * did.
 */
describe('witnessDisagreement', () => {
  it('is silent when both say it happened', () => {
    expect(witnessDisagreement({ appClaims: true, witnessSaw: true })).toBeUndefined();
  });

  it('is silent when both say it did not', () => {
    expect(witnessDisagreement({ appClaims: false, witnessSaw: false })).toBeUndefined();
  });

  it('FIRES when the app claims success and the witness saw nothing — the case it exists for', () => {
    const c = witnessDisagreement({ appClaims: true, witnessSaw: false });
    expect(c?.kind).toBe('witness-disagrees');
    expect(c?.because).toMatch(/did not see/i);
  });

  it('fires the other way too — the witness saw a write the app never claimed', () => {
    // Rarer and worth just as much: a double-submit the UI hid, or a side effect nobody asked for.
    const c = witnessDisagreement({ appClaims: false, witnessSaw: true });
    expect(c?.kind).toBe('witness-disagrees');
    expect(c?.because).toMatch(/saw/i);
  });

  it('is INCONCLUSIVE, never agreement, when the witness could not be reached', () => {
    const c = witnessDisagreement({
      appClaims: true,
      witnessSaw: undefined,
      unreachable: 'ECONNREFUSED',
    });
    expect(c?.kind).toBe('witness-unreachable');
    expect(c?.inconclusive).toBe(true);
    // The reason travels: an agent that cannot see WHY will retry the same broken thing.
    expect(c?.because).toMatch(/ECONNREFUSED/);
  });

  it('does not claim a disagreement when the app claimed nothing and the witness is unreachable', () => {
    // Nothing was asserted and nothing could be checked: reporting a contradiction here would be
    // manufacturing a finding out of two absences.
    const c = witnessDisagreement({
      appClaims: false,
      witnessSaw: undefined,
      unreachable: 'timeout',
    });
    expect(c?.kind).toBe('witness-unreachable');
    expect(c?.inconclusive).toBe(true);
  });
});

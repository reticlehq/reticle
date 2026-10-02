import { describe, expect, it } from 'vitest';
import { DriftReason } from '@reticlehq/core';
import { unhealableMessage } from './heal-run.js';

/**
 * Heal blaming its confidence floor for a refusal that never reached the floor.
 *
 * MEASURED against the bench app. A templated testid was renamed in real source, and the two
 * halves of the product answered differently about the same flow: replay named
 * `nav-item-deployments` as the surviving match, while `verify { action: "heal" }` reported "no
 * nearest match cleared the confidence floor (HEAL_CONFIDENCE_MIN=0.5)". Read together they say
 * heal weighed that candidate and found it too weak.
 *
 * It never weighed anything. `proposeRebindWith` returns at its FIRST line for any drift that is
 * not TESTID_NOT_FOUND, so an expectation that failed to appear — which is what this flow had —
 * exits before confidence is computed. The refusal was right and its stated reason was invented,
 * which is worse than a bare refusal: it sent a reader to lower a floor that was never consulted.
 */
describe('why heal declined', () => {
  it('says a locator rename is not what broke, when no drift is an anchor drift', () => {
    const message = unhealableMessage([DriftReason.EXPECT_ELEMENT_NOT_FOUND]);
    // It may NAME the floor — saying it was never consulted is the correction. What it must not do
    // is present the floor as the cause, which is what sends a reader to lower it.
    expect(message).not.toMatch(/no nearest match cleared the confidence floor/);
    expect(message).toMatch(/never consulted/i);
    expect(message).toMatch(/nothing to rebind/i);
  });

  it('still blames the floor when a real anchor drift was weighed and rejected', () => {
    expect(unhealableMessage([DriftReason.TESTID_NOT_FOUND])).toContain('confidence floor');
  });

  it('blames the floor when at least one drift was genuinely rebindable', () => {
    expect(
      unhealableMessage([DriftReason.EXPECT_ELEMENT_NOT_FOUND, DriftReason.TESTID_NOT_FOUND]),
    ).toContain('confidence floor');
  });
});

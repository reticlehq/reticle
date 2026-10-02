/**
 * A healed anchor says it was healed (2.4).
 *
 * `applyHealChanges` rewrote `step.anchor.value` and recorded nothing else, so a flow whose locator
 * a machine rebound became byte-indistinguishable from one a person recorded by driving. Three
 * things are lost with it, and all three matter later rather than now:
 *
 * A replay that passes on a healed anchor is a weaker claim than one that passes on a recorded
 * anchor, because the rebind picked the element and the consequence only checked that SOMETHING
 * still satisfied it. The verdict could not say which kind of pass it was.
 *
 * A step healed twice is a locator that is not stable, which is worth knowing and was unknowable:
 * the second heal overwrote the first with no trace that there had been one.
 *
 * And a human reading the diff saw a changed testid with nothing saying who changed it or why.
 *
 * Additive and optional on purpose. A flow without the field reads exactly as it did, which is
 * every flow recorded before this shipped, and no file version moves.
 */
import { describe, expect, it } from 'vitest';
import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import { applyHealChanges } from './heal.js';

const HEALED_AT = 1_700_000_000_000;

const flow = (testid: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: testid } }],
});

describe('what a heal leaves behind in the flow file', () => {
  it('records the anchor it replaced, and when', () => {
    const { flow: healed } = applyHealChanges(
      flow('pay-now'),
      [{ step: 0, from: 'pay-now', to: 'submit-payment' }],
      () => HEALED_AT,
    );
    const step = healed.steps[0];
    expect(step?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'submit-payment' });
    expect(
      step?.healed,
      'a machine-rebound anchor is indistinguishable from a recorded one without this',
    ).toEqual({ from: 'pay-now', at: HEALED_AT });
  });

  it('keeps the ORIGINAL anchor across a second heal, not the intermediate one', () => {
    const once = applyHealChanges(
      flow('pay-now'),
      [{ step: 0, from: 'pay-now', to: 'submit-payment' }],
      () => HEALED_AT,
    ).flow;
    const twice = applyHealChanges(
      once,
      [{ step: 0, from: 'submit-payment', to: 'checkout-submit' }],
      () => HEALED_AT + 5,
    ).flow;
    const anchor = twice.steps[0]?.anchor;
    expect(anchor?.kind === AnchorKind.TESTID ? anchor.value : undefined).toBe('checkout-submit');
    expect(
      twice.steps[0]?.healed?.from,
      'the first recorded anchor is the one a reader wants; the middle name was never chosen by anybody',
    ).toBe('pay-now');
    expect(twice.steps[0]?.healed?.at).toBe(HEALED_AT + 5);
  });

  it('leaves a step nobody healed completely alone', () => {
    const { flow: healed } = applyHealChanges(
      flow('pay-now'),
      [{ step: 0, from: 'a-different-testid', to: 'submit-payment' }],
      () => HEALED_AT,
    );
    const untouched = healed.steps[0]?.anchor;
    expect(
      untouched?.kind === AnchorKind.TESTID ? untouched.value : undefined,
      'the change did not match this step',
    ).toBe('pay-now');
    expect(healed.steps[0]?.healed).toBeUndefined();
  });
});

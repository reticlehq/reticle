/**
 * Native-click destructive guard. The SDK path is tested in the browser package; this is the
 * same list, on the descriptor the native inspector returns, because a role that never reaches
 * here is a Payment option that is still refused.
 */
import { describe, expect, it } from 'vitest';
import { ActionType, DIALOG_CONSENT_ARG } from '@reticlehq/core';
import {
  assertNotDestructive,
  assertNotPaymentNavigation,
  confirmedByDeclaration,
  withOwnDialogConsent,
} from './act-danger.js';
import { runDrivenBy } from '@/hooks/driven-by.js';

describe('assertNotDestructive', () => {
  it('does not block a Payment option — selecting a document type is not a payment', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Payment', role: 'option' }),
    ).not.toThrow();
  });

  it('does not block Log out', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Log out', role: 'menuitem' }),
    ).not.toThrow();
  });

  // The same rule as the SDK path: a real link is a navigation, judged by where it goes.
  it('does not block a link whose text or same-app path has a money word', () => {
    for (const link of [
      { text: 'Checkout pay fails', role: 'link', href: '/issues/12' },
      { text: 'Orders & invoices', role: 'link', href: '/billing/payment' },
    ]) {
      expect(() => assertNotDestructive(ActionType.CLICK, {}, link)).not.toThrow();
    }
  });

  it('still blocks a link that destroys, and an inert link that says it does', () => {
    for (const link of [
      { text: 'Settings', role: 'link', href: '/account/delete' },
      { text: 'Delete account', role: 'link', href: '#' },
    ]) {
      expect(() => assertNotDestructive(ActionType.CLICK, {}, link)).toThrow(/confirmDangerous/);
    }
  });

  it('still blocks a Payment button', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Send payment', role: 'button' }),
    ).toThrow(/confirmDangerous/);
  });

  it('does not block a native click on a tile named by its filename', () => {
    expect(() =>
      assertNotDestructive(
        ActionType.CLICK,
        { native: true },
        {
          text: 'photo-remove-background.webm',
          role: 'img',
        },
      ),
    ).not.toThrow();
  });

  it('still blocks a hyphenated label that is not a filename', () => {
    expect(() =>
      assertNotDestructive(
        ActionType.CLICK,
        { native: true },
        {
          text: 'delete-account',
          role: 'button',
        },
      ),
    ).toThrow(/confirmDangerous/);
  });
});

/**
 * The agent's own declaration confirms the control it named — reported from a monorepo shop/admin
 * drive, where "Place order" and "Approve refund" each cost a refused round trip.
 */
describe('confirmedByDeclaration', () => {
  const PLACE_ORDER = { role: 'button', name: 'Place order' };

  // #2167 review: the declaration lets the control be pressed, and sends no positive consent, so
  // the app's own confirm() is still answered no.
  it('confirms a control named by its own dangerous words when the consequence is declared', () => {
    const BY_DECLARATION = { confirmDangerous: true };
    expect(confirmedByDeclaration({}, PLACE_ORDER, true)).toEqual(BY_DECLARATION);
    expect(confirmedByDeclaration({}, { text: 'Approve refund' }, true)).toEqual(BY_DECLARATION);
  });

  it("turns the caller's own flag into the positive consent, declaration or not", () => {
    const yes = { confirmDangerous: true, [DIALOG_CONSENT_ARG]: true };
    expect(confirmedByDeclaration({ confirmDangerous: true }, PLACE_ORDER, true)).toEqual(yes);
    expect(confirmedByDeclaration({ confirmDangerous: true }, PLACE_ORDER, false)).toEqual(yes);
  });

  it('does not confirm without a declared consequence', () => {
    expect(confirmedByDeclaration({}, PLACE_ORDER, false)).toEqual({});
  });

  it('does not confirm a ref or testid — neither says what the control does', () => {
    expect(confirmedByDeclaration({}, undefined, true)).toEqual({});
    expect(confirmedByDeclaration({}, { testid: 'place-order' }, true)).toEqual({});
  });

  it('does not confirm harmless words on a control the guard flags for another reason', () => {
    expect(confirmedByDeclaration({}, { role: 'button', name: 'Continue' }, true)).toEqual({});
  });

  it('never applies to a Harness call, whose outward guard decides alone', async () => {
    const out = await runDrivenBy({ harness: 'h1', driver: 'server' }, () =>
      Promise.resolve(confirmedByDeclaration({}, PLACE_ORDER, true)),
    );
    expect(out).toEqual({});
  });
});

/*
 * The payment boundary for the Harness is typing card details or leaving for a payment provider.
 * "Start free trial" was refused as "would need to pay" on 3 of 4 explores; a real checkout page is
 * still out of bounds unless the person asked to pay.
 */
describe('the Harness and payment', () => {
  const HARNESS = { harness: 'h1', driver: 'server' } as const;
  const drive = (asked: string, fn: () => void): Promise<void> =>
    runDrivenBy(HARNESS, () => new Promise<void>((resolve) => resolve(fn())), asked);

  it('presses Start free trial with confirmDangerous unset', async () => {
    await expect(
      drive('Sign up and look at the dashboard', () =>
        assertNotDestructive(ActionType.CLICK, {}, { text: 'Start free trial', role: 'button' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a link to a payment provider, and a navigation to one', async () => {
    await expect(
      drive('Sign up and look at the dashboard', () =>
        assertNotDestructive(
          ActionType.CLICK,
          { confirmDangerous: true },
          { text: 'Continue', role: 'link', href: 'https://checkout.stripe.com/c/pay/x' },
        ),
      ),
    ).rejects.toThrow(/would need to pay/);
    await expect(
      drive('Sign up and look at the dashboard', () =>
        assertNotPaymentNavigation('https://test.checkout.dodopayments.com/buy/p_1'),
      ),
    ).rejects.toThrow(/would need to pay/);
  });

  it('goes to the provider when the journey asks to pay, and never gates an agent', async () => {
    await expect(
      drive('She pays for the Pro plan', () =>
        assertNotPaymentNavigation('https://checkout.stripe.com/c/pay/x'),
      ),
    ).resolves.toBeUndefined();
    expect(() => assertNotPaymentNavigation('https://checkout.stripe.com/c/pay/x')).not.toThrow();
  });
});

/** #2167 review: the yes to an action's confirm() is a positive argument, given only from the flag. */
describe('withOwnDialogConsent', () => {
  it("adds the consent only for the caller's own confirmDangerous: true", () => {
    expect(withOwnDialogConsent({ confirmDangerous: true })).toEqual({
      confirmDangerous: true,
      [DIALOG_CONSENT_ARG]: true,
    });
    expect(withOwnDialogConsent({})).toEqual({});
    expect(withOwnDialogConsent({ confirmDangerous: false })).toEqual({ confirmDangerous: false });
    expect(withOwnDialogConsent({ confirmDangerous: 'true' })).toEqual({
      confirmDangerous: 'true',
    });
  });

  it('keeps the no when the flag comes with an explicit false, as compare sends it', () => {
    expect(withOwnDialogConsent({ confirmDangerous: true, [DIALOG_CONSENT_ARG]: false })).toEqual({
      confirmDangerous: true,
    });
  });

  it('gives no consent to a Harness call, whose run sets the flag for the whole journey', async () => {
    const out = await runDrivenBy({ harness: 'h1', driver: 'server' }, () =>
      Promise.resolve(withOwnDialogConsent({ confirmDangerous: true })),
    );
    expect(out).toEqual({ confirmDangerous: true });
  });

  it('drops a consent the caller wrote itself: the flag is the only way to give it', () => {
    expect(withOwnDialogConsent({ [DIALOG_CONSENT_ARG]: true })).toEqual({});
    expect(withOwnDialogConsent({ [DIALOG_CONSENT_ARG]: true, value: 'x' })).toEqual({
      value: 'x',
    });
  });
});

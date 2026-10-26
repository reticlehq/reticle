import { describe, expect, it } from 'vitest';
import {
  OutwardAction,
  isDangerousActionText,
  isDangerousNavigation,
  isLocalPage,
  isLoopbackHostname,
  isPaymentField,
  isPaymentProviderUrl,
  outwardActionOf,
  outwardActionsAsked,
  withoutFilenameTokens,
} from './security.js';

describe('isLoopbackHostname', () => {
  it('accepts literal IPv4, IPv6, and localhost loopback hosts', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.255.255.254')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
  });

  it('rejects DNS lookalikes and invalid IPv4 literals', () => {
    expect(isLoopbackHostname('127.evil.example')).toBe(false);
    expect(isLoopbackHostname('localhost.example')).toBe(false);
    expect(isLoopbackHostname('127.0.0.999')).toBe(false);
  });

  /**
   * The HTTP plane trusts a loopback Host as its guard against DNS rebinding. A browser that sends
   * `.localhost` names to a DNS server lets a hostile network answer `evil.localhost`, so these
   * names are not loopback here. `isLocalPage` accepts them for a page.
   */
  it('rejects a .localhost subdomain', () => {
    expect(isLoopbackHostname('app.localhost')).toBe(false);
    expect(isLoopbackHostname('evil.localhost')).toBe(false);
  });
});

describe('isLocalPage', () => {
  /**
   * RFC 6761 reserves `.localhost` for loopback, and browsers resolve it locally. Dev proxies such as
   * portless serve `https://<branch>.<app>.localhost`, one name for each git worktree. These pages
   * were read as remote, so the SDK refused to start and the bridge refused the origin.
   */
  it('accepts a page on a .localhost subdomain, and nothing that only contains the word', () => {
    expect(isLocalPage('https:', 'app.localhost')).toBe(true);
    expect(isLocalPage('https:', 'feat-x.app.localhost')).toBe(true);
    expect(isLocalPage('https:', 'APP.LOCALHOST')).toBe(true);
    expect(isLocalPage('https:', 'app.localhost.')).toBe(false);
    expect(isLocalPage('https:', 'evil-localhost')).toBe(false);
    expect(isLocalPage('https:', 'localhost.evil.example')).toBe(false);
    expect(isLocalPage('https:', '.localhost')).toBe(false);
  });
});

describe('isDangerousActionText', () => {
  it('matches destructive labels and separator-delimited tool names', () => {
    expect(isDangerousActionText('Delete account')).toBe(true);
    expect(isDangerousActionText('delete_account')).toBe(true);
    expect(isDangerousActionText('transfer-funds')).toBe(true);
  });

  it('does not block ordinary read-only controls', () => {
    expect(isDangerousActionText('Search records')).toBe(false);
    expect(isDangerousActionText('Open settings')).toBe(false);
  });
});

/**
 * "Send" is not a destructive verb, and treating it as one taxed ordinary buttons.
 *
 * Reported from the field: `Send check-in` (POST that logs a text message) and `I'm safe / arrived`
 * (a positive status update) were both blocked as potentially destructive, costing an extra
 * round-trip each on a routine verification pass. Neither deletes, removes or revokes anything.
 *
 * `send` was in the list to cover moving money, and it caught every ordinary "send a message",
 * "send an invite", "send a check-in" alongside it. The money cases are still guarded — through the
 * thing being sent rather than the act of sending — so `Send payment` is still blocked while
 * `Send message` is not.
 *
 * The guard is deliberately asymmetric: a false block costs one round-trip, a missed block can
 * charge somebody's card. So this narrows the trigger without lowering the money coverage, and the
 * assertions below pin BOTH directions to keep it that way.
 */
describe('the destructive-action classifier does not tax ordinary verbs', () => {
  it.each([
    'Send check-in',
    "I'm safe / arrived",
    'Send message',
    'Send invite',
    'Send feedback',
    'Resend code',
  ])('does not block %s', (label) => {
    expect(isDangerousActionText(label)).toBe(false);
  });

  it.each([
    'Send payment',
    'Send money',
    'Confirm payment',
    'Delete account',
    'Remove item',
    'Transfer funds',
    'Withdraw',
    'Revoke access',
    'Place order',
  ])('still blocks %s', (label) => {
    expect(isDangerousActionText(label)).toBe(true);
  });
});

/**
 * Signing out is reversible, and the word fires on almost every authenticated drive.
 *
 * Reported from the field: a `role=menuitem` labelled `Log out` was blocked on every session, and
 * `Payment` as a Radix Select option (a document type on a petty-cash form) was blocked as
 * money-moving. A guard that costs a turn on a control it was never written to catch trains agents
 * to pass `confirmDangerous` reflexively, which is worse than not having it.
 *
 * Logout comes off the list. `payment` stays — "Send payment" / "Confirm payment" are still money —
 * but an `option` is a value picker, not an action, so the role is consulted before the text.
 */
describe('the destructive-action classifier does not tax logout or a Payment option', () => {
  it.each(['Log out', 'Logout', 'Sign out', 'sign_out'])('does not block %s', (label) => {
    expect(isDangerousActionText(label)).toBe(false);
  });

  it('does not block Payment when the control is an option in a select', () => {
    expect(isDangerousActionText('Payment', 'option')).toBe(false);
  });

  it('still blocks a Payment button, which is the money-moving case the list is for', () => {
    expect(isDangerousActionText('Send payment', 'button')).toBe(true);
    expect(isDangerousActionText('Confirm payment')).toBe(true);
  });

  it('still blocks a destructive menuitem — the role exemption is for value pickers, not menus', () => {
    expect(isDangerousActionText('Delete account', 'menuitem')).toBe(true);
  });
});

describe('consequential is not the same as destructive', () => {
  /**
   * The guard's own contract, at the top of act-danger.ts: it exists to stop "a money-moving or
   * destructive control". A deploy is neither — nothing is destroyed and no money moves. It is
   * consequential and it is CREATIVE, and the list is not a list of consequential things or half
   * the buttons in a dev tool would be on it.
   *
   * Measured, which is why this changed: three benchmark runs lost their whole budget to "New
   * deploy" being refused. Improving the refusal's wording did not rescue the last of them — the
   * agent spent its remaining turns weighing a bug report about the block and hunting a
   * workaround. A guard that costs a run on a control it was never written to catch is not
   * protecting anything; it is teaching agents to route around it.
   */
  it('does not block a deploy or a publish', () => {
    expect(isDangerousActionText('New deploy')).toBe(false);
    expect(isDangerousActionText('Deploy to production')).toBe(false);
    expect(isDangerousActionText('Publish')).toBe(false);
    expect(isDangerousActionText('publish-post')).toBe(false);
  });

  /** Everything the guard IS for stays exactly as it was. */
  it('still blocks destruction and money', () => {
    for (const label of [
      'Delete account',
      'Remove member',
      'Revoke token',
      'Terminate instance',
      'Refund payment',
      'Transfer funds',
      'Withdraw',
      'Place order',
      'Cancel subscription',
    ]) {
      expect(isDangerousActionText(label)).toBe(true);
    }
  });
});

/*
 * From persona drives: the Harness pressed Invite in a customer's workspace although its journey
 * said "she does not send an invite"; a planner-invented journey pressed Invite too.
 */
describe('what the Harness may press', () => {
  it('names the outward action a control would take', () => {
    expect(outwardActionOf('Invite')).toBe(OutwardAction.INVITE);
    expect(outwardActionOf('Send invitation')).toBe(OutwardAction.INVITE);
    expect(outwardActionOf('Send message')).toBe(OutwardAction.SEND);
    expect(outwardActionOf('Remove member')).toBe(OutwardAction.DELETE);
    expect(outwardActionOf('Create API key')).toBe(OutwardAction.CREATE_KEY);
    expect(outwardActionOf('Sign out')).toBe(OutwardAction.SIGN_OUT);
    expect(outwardActionOf('Open Runs')).toBeUndefined();
    expect(outwardActionOf('Remove', 'option')).toBeUndefined();
  });

  // A re-drive: in a read-only journey ("opens the fixed issue…") the Harness pressed Reassign and
  // Reopen, declaring a write for each. Changing an item's state is an outward action too.
  it("names changing an item's state, and a journey that only looks asks for none", () => {
    expect(outwardActionOf('Reassign')).toBe(OutwardAction.CHANGE_STATE);
    expect(outwardActionOf('Reopen issue')).toBe(OutwardAction.CHANGE_STATE);
    expect(outwardActionOf('Archive')).toBe(OutwardAction.CHANGE_STATE);
    expect(outwardActionsAsked('Ben opens the fixed issue and reads who fixed it')).toEqual([]);
    expect(outwardActionsAsked('Reopen the issue and check it is open again')).toEqual([
      OutwardAction.CHANGE_STATE,
    ]);
  });

  /*
   * Three of four explores failed because the Harness refused "Start free trial" as "would need to
   * pay". The payment boundary is entering card details or leaving for a payment provider, never the
   * words on a button.
   */
  it('presses a button whose label mentions a trial, an upgrade or a payment', () => {
    for (const label of ['Start free trial', 'Upgrade', 'Subscribe', 'Checkout', 'Place order']) {
      expect(outwardActionOf(label)).toBeUndefined();
    }
  });

  it('names a link or form that leaves for a payment provider as paying', () => {
    expect(outwardActionOf('Pay now https://checkout.stripe.com/c/pay/cs_1')).toBe(
      OutwardAction.PAY,
    );
    expect(outwardActionOf('https://test.checkout.dodopayments.com/buy/p_1')).toBe(
      OutwardAction.PAY,
    );
    expect(outwardActionOf('https://www.paypal.com/checkoutnow')).toBe(OutwardAction.PAY);
    expect(outwardActionOf('Docs https://notstripe.com/pricing')).toBeUndefined();
    expect(outwardActionOf('/billing/checkout')).toBeUndefined();
  });

  it('knows a payment provider by its origin', () => {
    expect(isPaymentProviderUrl('https://buy.stripe.com/x')).toBe(true);
    expect(isPaymentProviderUrl('https://sandbox-checkout.paddle.com/x')).toBe(true);
    expect(isPaymentProviderUrl('https://app.lemonsqueezy.com/x')).toBe(true);
    expect(isPaymentProviderUrl('https://api.razorpay.com/x')).toBe(true);
    expect(isPaymentProviderUrl('https://payments.braintreegateway.com/x')).toBe(true);
    expect(isPaymentProviderUrl('https://stripe.com.example.net/x')).toBe(false);
    expect(isPaymentProviderUrl('/checkout')).toBe(false);
  });

  it('knows a card or bank field by its autocomplete, name or label', () => {
    expect(isPaymentField({ autocomplete: 'cc-number' })).toBe(true);
    expect(isPaymentField({ autocomplete: 'cc-csc' })).toBe(true);
    expect(isPaymentField({ autocomplete: 'cc-exp-month' })).toBe(true);
    expect(isPaymentField({ name: 'cardNumber' })).toBe(true);
    expect(isPaymentField({ id: 'card-cvc' })).toBe(true);
    expect(isPaymentField({ label: 'Expiry date' })).toBe(true);
    expect(isPaymentField({ name: 'iban' })).toBe(true);
    expect(isPaymentField({ inputMode: 'numeric', name: 'cvv' })).toBe(true);
    expect(isPaymentField({ autocomplete: 'email', name: 'email', label: 'Email' })).toBe(false);
    expect(isPaymentField({ inputMode: 'numeric', name: 'quantity' })).toBe(false);
    expect(isPaymentField({ name: 'promo', label: 'Promo code' })).toBe(false);
  });

  it('reads what a journey asks for, and what it forbids', () => {
    expect(outwardActionsAsked('Invite a teammate by email and check the row appears')).toEqual([
      OutwardAction.INVITE,
    ]);
    expect(
      outwardActionsAsked('Tess limits a contractor to one project. She does not send an invite.'),
    ).toEqual([]);
    expect(outwardActionsAsked('Open the members page without sending the invitation')).toEqual([]);
    expect(outwardActionsAsked('Open Runs and read the failed check')).toEqual([]);
  });
});

/** A link to `/billing/payment` with the text "Orders & invoices" was refused as a payment (#1275). */
describe('isDangerousNavigation', () => {
  it('does not refuse a same-app page because its path has a money word', () => {
    for (const href of ['/billing/payments', '/billing/payment', '/shop/buy', '/orders/refund']) {
      expect(isDangerousNavigation(href)).toBe(false);
    }
  });

  it('refuses a path that destroys something', () => {
    expect(isDangerousNavigation('/account/delete')).toBe(true);
    expect(isDangerousNavigation('/settings/close-account')).toBe(true);
    expect(isDangerousNavigation('/tokens/revoke_all')).toBe(true);
  });

  it('refuses a payment provider URL', () => {
    expect(isDangerousNavigation('https://checkout.stripe.com/c/pay/xyz')).toBe(true);
  });
});

/**
 * Extensions with a digit: `mp4` and `mp3` are in the known-extension set, but the scan
 * that strips filename tokens read extension letters only, so it stopped at the digit
 * and never matched them. Reported on #1620: `clip-remove.mp4` and `song-delete.mp3`
 * kept their destructive words and stayed blocked, while
 * `photo-remove-background.webm` was stripped.
 */
describe('withoutFilenameTokens strips filenames whose extension contains a digit', () => {
  it.each(['clip-remove.mp4', 'song-delete.mp3', 'photo-remove-background.webm'])(
    'strips %s down to a blank',
    (label) => {
      expect(withoutFilenameTokens(label)).toBe(' ');
    },
  );

  it('strips a digit-extension filename inside a longer label, keeping the other words', () => {
    expect(withoutFilenameTokens('Play clip-remove.mp4 now')).toBe('Play   now');
    expect(withoutFilenameTokens('Remove clip-remove.mp4')).toBe('Remove  ');
  });

  it('still leaves a token whose digit extension is not a known one', () => {
    expect(withoutFilenameTokens('clip-remove.mp5')).toBe('clip-remove.mp5');
  });
});

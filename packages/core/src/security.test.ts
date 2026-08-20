import { describe, expect, it } from 'vitest';
import { isDangerousActionText, isLoopbackHostname } from './security.js';

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

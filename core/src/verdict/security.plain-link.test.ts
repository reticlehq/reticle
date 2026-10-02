/**
 * A plain navigation link is not a destructive control, however its URL is spelled.
 *
 * The destructive-label pattern reads a control's `href` along with its text, which is right for a
 * button whose label is an icon — its `formAction` is the only place it says what it does. On an
 * anchor the href is an ADDRESS, and addresses carry the pattern's words: `Orders & invoices`
 * pointing at `/billing/payment` was refused for the `payment` in the URL.
 *
 * A same-origin `<a href>` with no click handler, form or method changes nothing by itself; it is a
 * GET navigation. Refusing it costs a turn, and the way past is `confirmDangerous: true`, passed
 * reflexively — which is how a guard becomes decoration. The two controls that CAN act through a
 * link keep their block: one with an inline handler, and one inside a form.
 *
 * The link exemption is `classifyActionText`, told about the element by its caller. It is not
 * `isDangerousActionText` with a role: a `role` is a free string any page can write, so a role-only
 * exemption would let `<div role="link">Delete account</div>` through.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyActionText,
  isDangerousActionText,
  isPlainNavigationLink,
  type LinkAttributes,
} from './security.js';

describe('a plain navigation link is not destructive', () => {
  const link = (extra: Partial<LinkAttributes> = {}): LinkAttributes => ({
    href: '/billing/payment',
    isAnchor: true,
    hasClickHandler: false,
    insideForm: false,
    ...extra,
  });

  it('does not block a link whose text and href carry a money word', () => {
    expect(classifyActionText('Orders & invoices /billing/payment', 'link', link())).toBe(false);
    expect(
      classifyActionText('Purchase history', 'link', link({ href: '/purchase/history' })),
    ).toBe(false);
  });

  it('still blocks a link with a handler, which can do anything', () => {
    expect(
      classifyActionText(
        'Orders & invoices /billing/payment',
        'link',
        link({ hasClickHandler: true }),
      ),
    ).toBe(true);
  });

  it('still blocks a link inside a form, whose href is not its whole effect', () => {
    expect(
      classifyActionText('Purchase history /purchase/history', 'link', link({ insideForm: true })),
    ).toBe(true);
  });

  it('still blocks a role=link on an element that is not an anchor', () => {
    // `role` is a free string; only the element itself may grant the exemption.
    expect(
      classifyActionText('Delete account /purchase/now', 'link', link({ isAnchor: false })),
    ).toBe(true);
  });

  it('still blocks an executable href — a scheme decides what a string means', () => {
    for (const href of ['javascript:void 0', 'data:text/html,<button>Delete</button>']) {
      expect(classifyActionText('Delete account', 'link', link({ href }))).toBe(true);
    }
    // The money word in the TEXT is what blocks here, since the scheme already refused the
    // exemption; the point is that the scheme did not grant it in the first place.
    expect(
      classifyActionText(
        'Orders & invoices /billing/payment',
        'link',
        link({ href: 'javascript:void 0' }),
      ),
    ).toBe(true);
  });

  it('still blocks an href that is not navigation', () => {
    for (const href of ['mailto:billing@example.com', 'tel:+1234', '#', '']) {
      expect(classifyActionText('Delete account', 'link', link({ href }))).toBe(true);
    }
  });

  it('still blocks a BUTTON whose label is money-moving', () => {
    // The button case the href was added for: it has no href, and its label alone decides.
    expect(classifyActionText('Pay /api/charge', 'button', {})).toBe(true);
  });

  it('leaves the text-only classifier exactly as it was', () => {
    // The descriptor paths call this one; they have no element to answer the link question from.
    expect(isDangerousActionText('Delete account')).toBe(true);
    expect(isDangerousActionText('Orders & invoices /billing/payment', 'link')).toBe(true);
  });
});

describe('isPlainNavigationLink', () => {
  it('accepts an anchor with a navigation href and nothing wired to it', () => {
    for (const role of ['link', 'generic', 'LINK']) {
      expect(
        isPlainNavigationLink(role, {
          href: '/refund-policy',
          isAnchor: true,
          hasClickHandler: false,
          insideForm: false,
        }),
      ).toBe(true);
    }
  });

  it('accepts an absolute and a protocol-relative href', () => {
    for (const href of ['https://example.test/help', '//example.test/help']) {
      expect(isPlainNavigationLink('link', { href, isAnchor: true })).toBe(true);
    }
  });

  it('refuses every other role', () => {
    for (const role of ['button', 'menuitem', 'checkbox', 'option', 'radio', undefined]) {
      expect(isPlainNavigationLink(role, { href: '/billing/payment', isAnchor: true })).toBe(false);
    }
  });

  it('refuses an element that only claims to be a link', () => {
    expect(isPlainNavigationLink('link', { href: '/pay', isAnchor: false })).toBe(false);
    expect(isPlainNavigationLink('link', { href: '/pay' })).toBe(false);
  });

  it('refuses an anchor with a handler, a form, or an unusable href', () => {
    expect(
      isPlainNavigationLink('link', { href: '/pay', isAnchor: true, hasClickHandler: true }),
    ).toBe(false);
    expect(isPlainNavigationLink('link', { href: '/pay', isAnchor: true, insideForm: true })).toBe(
      false,
    );
    expect(isPlainNavigationLink('link', { isAnchor: true })).toBe(false);
    expect(isPlainNavigationLink('link', { href: 'javascript:void 0', isAnchor: true })).toBe(
      false,
    );
  });
});

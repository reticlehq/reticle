/**
 * Native-click destructive guard. The SDK path is tested in the browser package; this is the
 * same list, on the descriptor the native inspector returns, because a role that never reaches
 * here is a Payment option that is still refused.
 */
import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { assertDragNotDestructive, assertNotDestructive } from './act-danger.js';

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

  it('still blocks a Payment button', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Send payment', role: 'button' }),
    ).toThrow(/confirmDangerous/);
  });

  /**
   * The inspector reports the anchor's own facts, because this path has no element to read.
   *
   * Without them a plain navigation link is classified on its href, and `/billing/payments` reads
   * as money-moving. A link with an inline handler keeps its block, which is the whole reason those
   * two fields travel.
   */
  it('does not block a plain navigation link whose href carries a money word', () => {
    expect(() =>
      assertNotDestructive(
        ActionType.CLICK,
        {},
        {
          text: 'Orders & invoices',
          role: 'link',
          href: '/billing/payment',
          isAnchor: true,
          hasClickHandler: false,
          insideForm: false,
        },
      ),
    ).not.toThrow();
  });

  it('still blocks a link with a handler, an executable href, or a non-anchor claiming the role', () => {
    const plain = {
      text: 'Orders & invoices /billing/payment',
      role: 'link',
      href: '/billing/payment',
      isAnchor: true,
      hasClickHandler: false,
      insideForm: false,
    };
    // Every one of these is refused the exemption, so the money word in the text still blocks.
    for (const bad of [
      { ...plain, hasClickHandler: true },
      { ...plain, href: 'javascript:void 0' },
      { ...plain, isAnchor: false, role: 'button' },
      { ...plain, insideForm: true },
      { ...plain, href: '#' },
    ]) {
      expect(() => assertNotDestructive(ActionType.CLICK, {}, bad)).toThrow(/confirmDangerous/);
    }
  });

  it('keeps the old answer for a descriptor that carries no anchor facts', () => {
    expect(() =>
      assertNotDestructive(
        ActionType.CLICK,
        {},
        { text: 'Orders & invoices', role: 'link', href: '/billing/payment' },
      ),
    ).toThrow(/confirmDangerous/);
  });

  /**
   * A drag END is never navigation, so a plain-looking link as the drop target keeps its block.
   */
  it('still blocks a drag whose target is a plain navigation link', () => {
    expect(() =>
      assertDragNotDestructive(
        {},
        { text: 'Row', role: 'row' },
        {
          text: 'Pay now',
          role: 'link',
          href: '/billing/payment',
          isAnchor: true,
          hasClickHandler: false,
          insideForm: false,
        },
      ),
    ).toThrow(/confirmDangerous/);
  });
});

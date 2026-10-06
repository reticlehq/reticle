import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import {
  assertDragNotDestructive,
  assertNotDestructive,
  couldListenerReadingExempt,
} from './act-danger.js';

/**
 * The destructive-action guard on the descriptor path.
 *
 * The inspector reports the anchor's own facts, because this path has no element to read. The plain
 * navigation exemption then needs a reading that the link has NO handler, and that reading comes from
 * the CDP session (the fourth argument), never from the page: a page can prove a handler PRESENT and
 * never that one is absent, so the descriptor's own `hasClickHandler` can only ever keep the block.
 */
describe('assertNotDestructive', () => {
  it('does not block a Payment option: selecting a document type is not a payment', () => {
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

  /** The descriptor alone, with no CDP reading, keeps the block even for a handlerless anchor. */
  it('blocks a plain navigation link when no CDP reading was taken', () => {
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
    ).toThrow(/confirmDangerous/);
  });

  /**
   * The exemption, on a descriptor the CDP session proved handlerless.
   *
   * `false` is the one reading a page cannot supply and a CDP session can: `DOMDebugger` lists real
   * listeners, so a `false` here means every node in the chain was read and none had one.
   */
  it('exempts a plain navigation link the CDP reading proved handlerless', () => {
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
        false,
      ),
    ).not.toThrow();
  });

  it('blocks a link the CDP reading found a listener on', () => {
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
        true,
      ),
    ).toThrow(/confirmDangerous/);
  });

  /**
   * A page-proved handler always blocks, and no CDP reading can undo it. This is the direction that
   * must not be reversible: the reading narrows, it never widens.
   */
  it('blocks when the page itself proved a handler, whatever the CDP reading says', () => {
    for (const reading of [undefined, false, true]) {
      expect(() =>
        assertNotDestructive(
          ActionType.CLICK,
          {},
          {
            text: 'Orders & invoices',
            role: 'link',
            href: '/billing/payment',
            isAnchor: true,
            hasClickHandler: true,
            insideForm: false,
          },
          reading,
        ),
      ).toThrow(/confirmDangerous/);
    }
  });

  it('still blocks a link with an executable href, a non-anchor, a form, the marker, or `#`', () => {
    const plain = {
      text: 'Orders & invoices /billing/payment',
      role: 'link',
      href: '/billing/payment',
      isAnchor: true,
      hasClickHandler: false,
      insideForm: false,
    };
    // Every one of these is refused the exemption even with a proven handlerless reading, so the
    // money word in the text still blocks.
    for (const bad of [
      { ...plain, href: 'javascript:void 0' },
      { ...plain, isAnchor: false, role: 'button' },
      { ...plain, insideForm: true },
      { ...plain, href: '#' },
      { ...plain, nonGetMarker: true },
    ]) {
      expect(() => assertNotDestructive(ActionType.CLICK, {}, bad, false)).toThrow(
        /confirmDangerous/,
      );
    }
  });

  /**
   * A caller spends a CDP round-trip only when a handlerless reading could actually exempt, so this
   * predicate must be false for everything refused for reasons a reading cannot touch.
   */
  it('knows when a handlerless reading could exempt, and when it could not', () => {
    const blockedAnchor = {
      text: 'Orders & invoices /billing/payment',
      role: 'link',
      href: '/billing/payment',
      isAnchor: true,
      insideForm: false,
    };
    // Blocked on the money word, and a handlerless reading would clear it.
    expect(couldListenerReadingExempt(blockedAnchor)).toBe(true);
    // Refused for reasons the reading cannot reach.
    expect(couldListenerReadingExempt({ text: 'Delete', role: 'button' })).toBe(false);
    expect(couldListenerReadingExempt({ ...blockedAnchor, hasClickHandler: true })).toBe(false);
    expect(couldListenerReadingExempt({ ...blockedAnchor, isAnchor: false })).toBe(false);
    expect(couldListenerReadingExempt({ ...blockedAnchor, insideForm: true })).toBe(false);
    expect(couldListenerReadingExempt({ ...blockedAnchor, nonGetMarker: true })).toBe(false);
    expect(couldListenerReadingExempt({ ...blockedAnchor, href: 'javascript:void 0' })).toBe(false);
  });

  it('blocks the descriptor INSPECT produces for a data-turbo-method link', () => {
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
          nonGetMarker: true,
        },
        false,
      ),
    ).toThrow(/confirmDangerous/);
  });

  it('keeps the old answer for a descriptor that carries no anchor facts', () => {
    // No `isAnchor`/`hasClickHandler`/`insideForm`, so the descriptor cannot describe a plain link
    // and the CDP reading has nothing to narrow.
    expect(() =>
      assertNotDestructive(
        ActionType.CLICK,
        {},
        { text: 'Orders & invoices /billing/payment', role: 'link', href: '/billing/payment' },
        false,
      ),
    ).toThrow(/confirmDangerous/);
  });

  /**
   * A drag end is not navigation, so a plain-looking drop target keeps its block however clean its
   * handler reading is. This pins the `navigation` branch that would otherwise be unreachable from
   * the tests.
   */
  it('still blocks a drag whose target is a plain navigation link', () => {
    const plainDropTarget = {
      text: 'Pay now /billing/payment',
      role: 'link',
      href: '/billing/payment',
      isAnchor: true,
      insideForm: false,
    };
    expect(() => assertDragNotDestructive({}, { text: 'Row' }, plainDropTarget)).toThrow(
      /confirmDangerous/,
    );
  });
});

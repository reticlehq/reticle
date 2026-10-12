/**
 * Native-click destructive guard. The SDK path is tested in the browser package; this is the
 * same list, on the descriptor the native inspector returns, because a role that never reaches
 * here is a Payment option that is still refused.
 */
import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { assertNotDestructive, confirmedByDeclaration } from './act-danger.js';
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

  it('still blocks a Payment button', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Send payment', role: 'button' }),
    ).toThrow(/confirmDangerous/);
  });
});

/**
 * The agent's own declaration confirms the control it named — reported from a monorepo shop/admin
 * drive, where "Place order" and "Approve refund" each cost a refused round trip.
 */
describe('confirmedByDeclaration', () => {
  const PLACE_ORDER = { role: 'button', name: 'Place order' };

  it('confirms a control named by its own dangerous words when the consequence is declared', () => {
    expect(confirmedByDeclaration({}, PLACE_ORDER, true)).toEqual({ confirmDangerous: true });
    expect(confirmedByDeclaration({}, { text: 'Approve refund' }, true)).toEqual({
      confirmDangerous: true,
    });
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

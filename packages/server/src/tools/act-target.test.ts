import { describe, expect, it, vi } from 'vitest';
import { ActionType } from '@reticlehq/core';
import type { Session } from '../session/session.js';
import { resolveActTarget } from './act-target.js';

/**
 * A global press is a document key. Requiring a ref forced an extra snapshot just to name an
 * element the keystroke is not about, and pressing against body/document was refused the same way.
 *
 * The QUERY must not run on this path: there is nothing to look up, and a lookup that fails would
 * turn "dismiss the dialog" into a locator miss.
 */
function sessionThatMustNotBeQueried(): {
  session: Session;
  command: ReturnType<typeof vi.fn>;
} {
  const command = vi.fn(() => {
    throw new Error('a global press must not query the page for a target');
  });
  return { session: { command } as unknown as Session, command };
}

describe('resolveActTarget — a document-key press needs no locator', () => {
  it('accepts Escape with neither ref nor target, and does not query', async () => {
    const { session, command } = sessionThatMustNotBeQueried();
    const r = await resolveActTarget(session, {
      action: ActionType.PRESS,
      args: { text: 'Escape' },
    });
    expect(r).toEqual({ kind: 'global', ref: '' });
    expect(command).not.toHaveBeenCalled();
  });

  it('accepts Tab, and a modifier shortcut, the same way', async () => {
    const { session } = sessionThatMustNotBeQueried();
    expect(
      await resolveActTarget(session, { action: ActionType.PRESS, args: { text: 'Tab' } }),
    ).toEqual({ kind: 'global', ref: '' });
    expect(
      await resolveActTarget(session, {
        action: ActionType.PRESS,
        args: { text: 'k', modifiers: ['Meta'] },
      }),
    ).toEqual({ kind: 'global', ref: '' });
  });

  it('still honours an explicit ref on a global key — a press aimed at a control keeps one', async () => {
    const { session } = sessionThatMustNotBeQueried();
    const r = await resolveActTarget(session, {
      ref: 'e12',
      action: ActionType.PRESS,
      args: { text: 'Escape' },
    });
    expect(r).toEqual({ kind: 'ref', ref: 'e12' });
  });

  it('still refuses a click, a default Enter, and a letter, when nothing was named', async () => {
    const { session } = sessionThatMustNotBeQueried();
    for (const args of [
      { action: ActionType.CLICK },
      { action: ActionType.PRESS, args: { text: 'Enter' } },
      { action: ActionType.PRESS, args: {} },
      { action: ActionType.PRESS, args: { text: 'a' } },
    ]) {
      const r = await resolveActTarget(session, args);
      expect(r.kind, JSON.stringify(args)).toBe('error');
      if ('error' !== r.kind) return;
      expect(r.message).toMatch(/`ref`/);
      expect(r.message).toMatch(/`target`/);
      expect(r.message, 'names the exception so the next call can omit the locator').toMatch(
        /Escape/,
      );
    }
  });
});

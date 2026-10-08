import { describe, expect, it } from 'vitest';
import { AnchorKind } from '@reticlehq/core';
import { ambiguityDrift, refFor } from './flow-anchor.js';
import { anchorForStep } from './flows.js';

/** From a recorded drive: `link "Transactions"` matched a sidebar and a card link on every replay. */
describe('a role anchor recorded among same-named controls', () => {
  const anchor = { kind: AnchorKind.ROLE, role: 'link', name: 'Transactions', nth: 1, of: 2 };

  it('is saved with its position', () => {
    const args = { by: 'role', value: 'link', name: 'Transactions', nth: 1, of: 2 };
    expect(anchorForStep(args).anchor).toEqual(anchor);
  });

  it('replays the recorded one while the page has as many as when it was recorded', () => {
    expect(ambiguityDrift(anchor, ['e1', 'e2'])).toBeNull();
    expect(refFor(anchor, ['e1', 'e2'])).toBe('e2');
  });

  it('is ambiguous again once the count changed, rather than guessing', () => {
    expect(ambiguityDrift(anchor, ['e1', 'e2', 'e3'])).not.toBeNull();
    expect(refFor(anchor, ['e1', 'e2', 'e3'])).toBeUndefined();
    const { nth: _n, of: _o, ...bare } = anchor;
    expect(ambiguityDrift(bare, ['e1', 'e2'])).not.toBeNull();
  });
});

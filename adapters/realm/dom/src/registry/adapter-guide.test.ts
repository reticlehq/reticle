import { describe, expect, it } from 'vitest';
import { identifyComponent, registerAdapter } from './adapters.js';

/**
 * The adapter guide's example has to compile and behave as written.
 *
 * `docs/adapters.md` tells somebody outside this repository how to add support for their framework.
 * A guide that has drifted from the code is worse than none: it costs a stranger an afternoon before
 * they conclude the tool does not work, and nobody here finds out.
 *
 * These are the promises that page makes, checked against the real registry.
 */

const elementIn = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  const child = host.firstElementChild;
  if (null === child) throw new Error('fixture produced no element');
  return child;
};

describe('what the adapter guide promises', () => {
  it('an adapter with a name and identify is enough', () => {
    // The guide's minimal example: no readState, no hasHoverHandlers.
    registerAdapter({
      name: 'guide-minimal',
      identify: (el) => (el.hasAttribute('data-mine') ? { componentStack: ['Mine'] } : null),
    });
    expect(identifyComponent(elementIn('<p data-mine>x</p>'))?.componentStack).toEqual(['Mine']);
  });

  it('returning null means "ask the next one", not "there is no answer"', () => {
    // The rule that keeps several adapters usable at once. An adapter that guessed for everything
    // would make every other one unreachable.
    registerAdapter({ name: 'guide-declines', identify: () => null });
    registerAdapter({
      name: 'guide-answers',
      identify: (el) => (el.hasAttribute('data-theirs') ? { componentStack: ['Theirs'] } : null),
    });
    expect(identifyComponent(elementIn('<p data-theirs>x</p>'))?.componentStack).toEqual([
      'Theirs',
    ]);
  });

  it('registering the same name twice leaves one', () => {
    const before = identifyComponent(elementIn('<p data-mine>x</p>'));
    registerAdapter({ name: 'guide-minimal', identify: () => ({ componentStack: ['Impostor'] }) });
    // Still the first registration, so a module re-evaluated by a dev server cannot replace an
    // adapter with a half-initialised copy of itself.
    expect(identifyComponent(elementIn('<p data-mine>x</p>'))).toEqual(before);
  });

  it('an element nobody claims is unidentified rather than guessed at', () => {
    expect(identifyComponent(elementIn('<span>nobody</span>'))).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { createCommandRegistry } from './commands.js';
import { refs } from '@/dom/addressing/refs.js';
import { INSPECT_REVEAL_ARG, ReticleCommand } from '@reticlehq/core';

/**
 * `inspect` with `reveal` scrolls an off-viewport element into view before it measures (#1711).
 *
 * A real gesture aims at the box `inspect` returns. Below the fold, that box is off the page, and
 * the pointer lands on nothing while the gesture reports `performed: true`. Without `reveal`,
 * `inspect` stays a read: it must never move the page for a caller that only asked to look.
 */
describe('inspect reveal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const inspect = (el: Element, args: Record<string, unknown> = {}): Record<string, unknown> => {
    const handler = createCommandRegistry().get(ReticleCommand.INSPECT);
    if (handler === undefined) throw new Error('no inspect command');
    return (handler({ ref: refs.refFor(el), ...args }) ?? {}) as Record<string, unknown>;
  };

  /** An element below the fold until something scrolls it into view. */
  const belowTheFold = (): { el: HTMLElement; scrolls: () => number } => {
    const el = document.createElement('button');
    el.textContent = 'Save';
    document.body.append(el);
    let scrolled = 0;
    const top = (): number => (0 < scrolled ? 100 : window.innerHeight + 2000);
    el.getBoundingClientRect = (): DOMRect => ({
      x: 10,
      y: top(),
      left: 10,
      top: top(),
      right: 110,
      bottom: top() + 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    });
    el.scrollIntoView = (): void => {
      scrolled += 1;
    };
    return { el, scrolls: () => scrolled };
  };

  it('scrolls an off-viewport element in, then measures where it now is', () => {
    const { el, scrolls } = belowTheFold();

    const out = inspect(el, { [INSPECT_REVEAL_ARG]: true });

    expect(scrolls()).toBe(1);
    expect(out['scrolledIntoView']).toBe(true);
    expect((out['box'] as { y: number }).y).toBe(100);
  });

  it('does not move the page when the caller did not ask to reveal', () => {
    const { el, scrolls } = belowTheFold();

    const out = inspect(el);

    expect(scrolls()).toBe(0);
    expect(out['scrolledIntoView']).toBeUndefined();
  });
});

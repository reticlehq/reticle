// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { ReticleCommand } from '@reticlehq/core';
import { createCommandRegistry } from './commands.js';
import { refs } from '@/dom/addressing/refs.js';

/**
 * The regression that beat us, caught — without a pixel.
 *
 * `bench/raw/visual-regression-bench.json` records the loss: a `filter: hue-rotate` changed 21,393
 * pixels (2.3%), a screenshot diff caught it, and `reticle_inspect` did not. That was read for a
 * year as "Reticle reads styles, not pixels".
 *
 * It was never that. The filter was on an ANCESTOR, so the element's own computed style was
 * identical before and after — correctly. We were composing nothing: CSS rasterisation runs down the
 * ancestor chain and a flat per-element read describes one link of it.
 *
 * This test is the same scenario, and it goes red if `inspect` ever stops composing. It asserts the
 * property that matters more than detection: the answer is ATTRIBUTED. A screenshot can say 21,393
 * pixels differ; it cannot say which element, which property, or what value — and an agent that
 * cannot name the cause cannot fix it.
 */
describe('inspect sees what an ancestor does to an element', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const inspect = (el: Element): Record<string, unknown> => {
    const handler = createCommandRegistry().get(ReticleCommand.INSPECT);
    if (handler === undefined) throw new Error('no inspect command');
    return (handler({ ref: refs.refFor(el) }) ?? {}) as Record<string, unknown>;
  };

  const target = (wrapperStyle: string): Element => {
    document.body.innerHTML = `<div id="wrap" style="${wrapperStyle}"><div id="target">Hello</div></div>`;
    const el = document.getElementById('target');
    if (null === el) throw new Error('fixture has no #target');
    return el;
  };

  it('says NOTHING when no ancestor is painting over it', () => {
    expect(inspect(target(''))['paintContext']).toBeUndefined();
  });

  it('CATCHES the ancestor filter, and names the element and the value', () => {
    const ctx = inspect(target('filter: hue-rotate(90deg)'))['paintContext'] as
      { on: string; property: string; value: string }[] | undefined;
    expect(ctx, 'this is the regression a screenshot caught and we did not').toBeDefined();
    expect(ctx?.[0]?.property).toBe('filter');
    expect(ctx?.[0]?.value).toContain('hue-rotate');
    // The half a screenshot structurally cannot give: WHICH element to go and edit.
    expect(ctx?.[0]?.on).toBe('#wrap');
  });

  it('catches an ancestor that makes it invisible without touching its style', () => {
    // `opacity: 0` on a parent: the child still reports its own colours, its own box, its own text.
    const ctx = inspect(target('opacity: 0'))['paintContext'] as { property: string }[] | undefined;
    expect(ctx?.some((c) => 'opacity' === c.property)).toBe(true);
  });
});

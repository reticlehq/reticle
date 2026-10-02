// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { createCommandRegistry } from './commands.js';
import { refs } from '@/dom/addressing/refs.js';
import { ReticleCommand } from '@reticlehq/core';

/**
 * Text cut off horizontally is a fact the agent can read, not something it has to see.
 *
 * `inspect` reported `scrollTop`/`scrollHeight`/`clientHeight`/`overflowY` — the Y axis only. So a
 * vertically-scrolling panel was measurable and the single most common visual defect on the web was
 * not: a label wider than its box, clipped with an ellipsis. `text-overflow: ellipsis` is the one
 * CSS property whose whole job is to HIDE the evidence that content did not fit.
 *
 * The source is no help here, and this is the case that answers "we already wrote `truncate` in the
 * class list". `truncate` is a request to clip IF the content overflows. Whether it overflowed
 * depends on the rendered string, the font that actually loaded, the container the flex parent
 * granted, and the user's zoom — none of which are in the source. The class being present proves
 * only that clipping was permitted; `scrollWidth > clientWidth` proves it happened.
 *
 * Two fields. They make the difference between an agent inferring truncation from a screenshot and
 * an agent reading it.
 */
describe('inspect reports horizontal overflow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const inspect = (el: Element): Record<string, unknown> => {
    const handler = createCommandRegistry().get(ReticleCommand.INSPECT);
    if (handler === undefined) throw new Error('no inspect command');
    return (handler({ ref: refs.refFor(el) }) ?? {}) as Record<string, unknown>;
  };

  it('reports the X axis beside the Y axis', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const scroll = inspect(el)['scroll'] as Record<string, unknown> | undefined;
    expect(scroll, 'inspect must report a scroll block').toBeDefined();
    for (const field of ['scrollWidth', 'clientWidth', 'overflowX']) {
      expect(Object.keys(scroll ?? {}), `${field} is what makes truncation readable`).toContain(
        field,
      );
    }
  });

  it('keeps every Y field it already reported', () => {
    // Widening must not shuffle: these are what a scrolling panel is diagnosed with today.
    const el = document.createElement('div');
    document.body.append(el);
    const scroll = inspect(el)['scroll'] as Record<string, unknown> | undefined;
    for (const field of ['scrollTop', 'scrollHeight', 'clientHeight', 'overflowY']) {
      expect(Object.keys(scroll ?? {})).toContain(field);
    }
  });
});

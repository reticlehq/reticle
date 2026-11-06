import { describe, it, expect, beforeEach } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { matchQuery } from './query.js';

/**
 * #1648: `state: "visible"` reads a painted aria-hidden element as hidden, and there was no way
 * to assert "painted". An element carrying `aria-hidden="true"` (like a decorative WebGL <canvas>
 * or background layer) is painted on screen but excluded from the accessibility tree.
 *
 * `state: "painted"` allows asserting that the element is rendered on screen regardless of ARIA.
 * A `state: "visible"` miss on an element that is painted but hidden only by aria-hidden names it
 * in `hint.ariaHiddenState`.
 */
describe('state: "painted" and ariaHiddenState hint (#1648)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches a painted element carrying aria-hidden="true" when asking for state: "painted"', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas>';

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(true);
    expect(painted.count).toBe(1);
    expect(painted.elements[0]?.states).toContain('painted');
  });

  it('fails state: "visible" on an aria-hidden canvas, but sets hint.ariaHiddenState', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas>';

    const visible = matchQuery({ testid: 'bg' }, ElementState.VISIBLE);
    expect(visible.matched).toBe(false);
    expect(visible.hint?.ariaHiddenState).toBe(true);
  });

  it('does not match state: "painted" when the element is hidden by CSS (display: none)', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="display: none;"></canvas>';

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(false);
    expect(painted.hint?.ariaHiddenState).toBeUndefined();
  });

  it('does not match state: "painted" when the element is hidden by CSS (visibility: hidden)', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="visibility: hidden;"></canvas>';

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(false);
    expect(painted.hint?.ariaHiddenState).toBeUndefined();
  });

  it('matches both state: "visible" and state: "painted" on a normal element', () => {
    document.body.innerHTML = '<div data-testid="content">Hello World</div>';

    const visible = matchQuery({ testid: 'content' }, ElementState.VISIBLE);
    expect(visible.matched).toBe(true);

    const painted = matchQuery(
      { testid: 'content' },
      (ElementState as Record<string, ElementState>).PAINTED ?? 'painted',
    );
    expect(painted.matched).toBe(true);
  });
});

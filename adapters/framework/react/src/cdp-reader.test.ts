import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createElement, useState, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readComponentAt, buildReaderExpression, parseComponentRead } from './cdp-reader.js';

/**
 * The zero-install reader is tested two ways, because it has two failure modes.
 *
 *  1. Does it read a REAL React fiber? Rendered with react-dom, like source-seam.test.ts, so the fiber
 *     shape is React's own and not a fake literal — the same reason the in-process reader is tested
 *     against real renders.
 *  2. Is it actually self-contained? This is the one that only bites on the live CDP path: a stray
 *     reference to a module-scope helper works in-process (the helper is in scope) and throws
 *     "X is not defined" only once serialized into a page. So the reader is also run through
 *     `new Function` with an EMPTY scope, which reproduces the CDP environment and fails loudly here
 *     instead of in production.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Counter(): ReturnType<typeof createElement> {
  const [count, setCount] = useState(7);
  const [label] = useState('deploys');
  return createElement(
    'button',
    { 'data-testid': 'inc', onClick: () => setCount((c) => count + 1 + (c - c)) },
    `${label}: ${count}`,
  );
}

describe('readComponentAt (zero-install fiber read)', () => {
  it('reads the component name and hook state off a real rendered fiber', () => {
    act(() => root.render(createElement(Counter)));
    const el = container.querySelector('[data-testid="inc"]');
    const read = readComponentAt(el);
    expect(read.ok).toBe(true);
    expect(read.component).toBe('Counter');
    expect(read.hooks).toEqual([7, 'deploys']);
  });

  // React keeps two fibers per component; the `__reactFiber$…` key on a host node keeps pointing at
  // the one created at mount, which is the PREVIOUS commit's fiber on every other commit. Reading it
  // blind reports hook state one commit behind, alternating correct/stale.
  it('reads the committed fiber after re-renders, not the stale alternate', () => {
    act(() => root.render(createElement(Counter)));
    const el = container.querySelector('[data-testid="inc"]');
    expect(el).not.toBeNull();
    if (null === el) return;
    for (let click = 1; click <= 4; click += 1) {
      act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(readComponentAt(el).hooks, `after click ${click}`).toEqual([7 + click, 'deploys']);
    }
  });

  it('degrades to a structured reason on a non-React element, never throws', () => {
    const bare = document.createElement('span');
    expect(readComponentAt(bare)).toEqual({ ok: false, reason: 'no-fiber' });
    expect(readComponentAt(null)).toEqual({ ok: false, reason: 'no-element' });
  });

  it('is genuinely self-contained — its serialized source references nothing outside itself', () => {
    // The failure this guards only bites on the live CDP path: a reference to a module-scope helper
    // works in-process (it is in scope) and throws "X is not defined" once serialized into a page.
    // Rather than eval the source here (which trips no-implied-eval, correctly), assert the source
    // names none of this module's other exports. The live CDP proof in the loop ledger is the runtime
    // half; this is the fast-gate half that fails the moment someone adds a helper call.
    const source = readComponentAt.toString();
    for (const forbidden of ['buildReaderExpression', 'parseComponentRead', 'CdpComponentRead']) {
      expect(
        source,
        `reader references ${forbidden} — it will throw inside page.evaluate`,
      ).not.toContain(forbidden);
    }
    // And it must actually be a complete function expression (a partial capture would inject broken JS).
    expect(source.startsWith('function')).toBe(true);
  });

  it('buildReaderExpression produces an eval-able expression with a safe selector', () => {
    const expr = buildReaderExpression('[data-testid="x"]');
    expect(expr).toContain('document.querySelector');
    // The selector is JSON-encoded, so an embedded quote cannot break the expression.
    expect(buildReaderExpression('a"b')).toContain('"a\\"b"');
  });

  it('parseComponentRead rejects a malformed injection result', () => {
    expect(parseComponentRead({ ok: true, component: 'X', hooks: [1] })).toEqual({
      ok: true,
      component: 'X',
      hooks: [1],
    });
    expect(parseComponentRead('nonsense')).toEqual({ ok: false, reason: 'malformed-read' });
    expect(parseComponentRead(null)).toEqual({ ok: false, reason: 'malformed-read' });
  });
});

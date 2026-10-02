import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { identify } from './index.js';

/**
 * The seam nothing covered: a REALLY-RENDERED element resolving to a real source pointer.
 *
 * The rest of this chain was already tested against reality — the babel plugin runs a genuine
 * `@babel/core` transform over real JSX and asserts `src/Foo.tsx:1:col`, and the vite plugin asserts
 * it stamps `.tsx`. What no test did was join the two ends: take an element as React actually put it
 * in the DOM and ask `identify()` for its source.
 *
 * That join is the whole feature on React 19+. React dropped `_debugSource`, so the fiber branch in
 * `identify()` is dead there and the attribute fallback IS the mechanism — which means every fiber
 * test in this package, all of which build fake fiber literals, exercises a path that modern React
 * never takes. This test uses the path that ships.
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

/** What the babel plugin emits: the host element carries file:line:col. */
function StampedButton(): ReturnType<typeof createElement> {
  return createElement('button', {
    'data-reticle-source': 'src/Checkout.tsx:42:6',
    'data-testid': 'pay',
  });
}

describe('source pointer, end to end through a real render', () => {
  it('resolves a rendered element to the file and line the plugin stamped', () => {
    act(() => root.render(createElement(StampedButton)));
    const el = container.querySelector('[data-testid="pay"]');
    expect(el).not.toBeNull();

    const info = identify(el as Element);
    expect(info?.source?.file).toBe('src/Checkout.tsx');
    expect(info?.source?.line).toBe(42);
  });

  it('names the component that rendered it, not just the file', () => {
    // The pointer and the component stack are separate claims: the stack comes from the fiber, the
    // file from the attribute. A test that only checked source could pass while the stack was empty.
    act(() => root.render(createElement(StampedButton)));
    const info = identify(container.querySelector('[data-testid="pay"]') as Element);
    expect(info?.componentStack).toContain('StampedButton');
  });

  it('returns no source for an unstamped element rather than inventing one', () => {
    // Production builds and apps without the plugin have no stamp. A guessed pointer would be worse
    // than none — it sends the agent to the wrong file with full confidence.
    function Bare(): ReturnType<typeof createElement> {
      return createElement('span', { 'data-testid': 'bare' });
    }
    act(() => root.render(createElement(Bare)));
    const info = identify(container.querySelector('[data-testid="bare"]') as Element);
    expect(info?.source).toBeUndefined();
  });
});

/**
 * React writes `_debugSource: null` on fibers it has no JSX source for — the type said `undefined`,
 * so `!== undefined` let the null through and the very next line dereferenced it:
 *
 *   Cannot read properties of null (reading 'fileName')
 *
 * `identify()` is on the ACT path as well as the inspect path, so ONE null fiber anywhere in the walk
 * took out `reticle_act`, `reticle_act_and_wait` and `reticle_inspect` for the whole app. The
 * read-only tools kept working, so the agent could see the app perfectly and could not touch it — and
 * the React 19 attribute fallback below never got the chance to run. Measured on two real apps.
 */
describe('identify — a fiber with no JSX source must not take out the walk', () => {
  function PayButton(): null {
    return null;
  }

  /** A fiber tree shaped the way React actually leaves it: _debugSource present, and null. */
  function elementWithNullDebugSource(attrs: Record<string, string> = {}): Element {
    const el = document.createElement('button');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const componentFiber = {
      return: null,
      type: PayButton,
      elementType: PayButton,
      _debugSource: null,
    };
    const hostFiber = {
      return: componentFiber,
      type: 'button',
      elementType: 'button',
      _debugSource: null,
    };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;
    return el;
  }

  it('does not throw — this is what broke driving on two real apps', () => {
    const el = elementWithNullDebugSource();
    expect(() => identify(el)).not.toThrow();
  });

  it('still names the component from the fiber walk', () => {
    expect(identify(elementWithNullDebugSource())?.componentStack).toContain('PayButton');
  });

  it('lets the React 19 attribute fallback run, which the throw pre-empted', () => {
    const el = elementWithNullDebugSource({ 'data-reticle-source': 'src/Checkout.tsx:42:6' });
    const info = identify(el);
    expect(info?.source?.file).toBe('src/Checkout.tsx');
    expect(info?.source?.line).toBe(42);
  });

  it('a null columnNumber is survivable too — same shape, one field down', () => {
    const el = document.createElement('button');
    const hostFiber = {
      return: null,
      type: 'button',
      elementType: 'button',
      _debugSource: { fileName: 'src/A.tsx', lineNumber: 3, columnNumber: null },
    };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;
    const info = identify(el);
    expect(info?.source?.file).toBe('src/A.tsx');
    expect(info?.source?.column).toBeUndefined();
  });
});

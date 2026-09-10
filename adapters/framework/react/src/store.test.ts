import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createElement, useReducer, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { readStores, storeNames, unregisterStore } from '@reticlehq/browser';
import { useReticleStore } from './store.js';

// React only honours act() when this global is set; without it act still runs the work but warns and
// stops flushing effects synchronously, which is exactly the behaviour these tests depend on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Rendered with the REAL React renderer, not a mocked one.
 *
 * The whole reason this hook exists is that React's built-in state has no store object to adapt — the
 * value lives in the fiber tree and the only signal is a commit. A test that mocked useEffect would
 * assert the mock's semantics, not React's, and would keep passing if the effect ordering that makes
 * this correct ever changed.
 */
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
  unregisterStore('cart');
});

function Harness({ children }: { children?: ReactNode }): ReactNode {
  return children ?? null;
}

/** A component holding useReducer state and publishing it — the Context/useReducer shape. */
function CartProvider({ onReady }: { onReady: (dispatch: () => void) => void }): ReactNode {
  const [items, add] = useReducer((prev: string[]) => [...prev, `item${prev.length}`], []);
  useReticleStore('cart', { items, count: items.length });
  onReady(add);
  return createElement(Harness, null, null);
}

describe('useReticleStore', () => {
  it('registers the store so an agent can read state React never exposes', () => {
    let dispatch = (): void => {};
    act(() => {
      root.render(
        createElement(CartProvider, {
          onReady: (d) => {
            dispatch = d;
          },
        }),
      );
    });
    expect(storeNames()).toContain('cart');
    expect(readStores('cart')['cart']).toEqual({ items: [], count: 0 });
    expect(dispatch).toBeTypeOf('function');
  });

  it('the registered value tracks state across commits', () => {
    let dispatch = (): void => {};
    act(() => {
      root.render(
        createElement(CartProvider, {
          onReady: (d) => {
            dispatch = d;
          },
        }),
      );
    });
    act(() => dispatch());
    expect(readStores('cart')['cart']).toEqual({ items: ['item0'], count: 1 });
    act(() => dispatch());
    expect(readStores('cart')['cart']).toEqual({ items: ['item0', 'item1'], count: 2 });
  });

  it('unregisters on unmount, so a stale store cannot answer for a gone component', () => {
    act(() => {
      root.render(createElement(CartProvider, { onReady: () => {} }));
    });
    expect(storeNames()).toContain('cart');
    act(() => root.unmount());
    expect(storeNames()).not.toContain('cart');
  });
});

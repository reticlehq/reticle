import { describe, it, expect, afterEach } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ComponentStateReason, type ComponentStateResult } from '@reticlehq/core';
import { identify, readState, hasHoverHandlers } from './index.js';

function PayButton(): null {
  return null;
}

describe('react adapter fiber walk', () => {
  it('resolves component stack and source file from the fiber tree', () => {
    const el = document.createElement('button');
    const componentFiber = {
      return: null,
      type: PayButton,
      elementType: PayButton,
      _debugSource: { fileName: 'src/checkout/PayButton.tsx', lineNumber: 24, columnNumber: 6 },
    };
    const hostFiber = { return: componentFiber, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;

    const info = identify(el);
    expect(info).not.toBeNull();
    expect(info?.componentStack).toContain('PayButton');
    expect(info?.source?.file).toBe('src/checkout/PayButton.tsx');
    expect(info?.source?.line).toBe(24);
  });

  it('returns null for a non-React element', () => {
    const el = document.createElement('div');
    expect(identify(el)).toBeNull();
  });

  it('filters framework wrappers (Next/React internals) from the stack', () => {
    function Page(): null {
      return null;
    }
    function LayoutRouterContext(): null {
      return null;
    }
    function AppRouter(): null {
      return null;
    }
    const el = document.createElement('button');
    const root = { return: null, type: AppRouter, elementType: AppRouter };
    const ctx = { return: root, type: LayoutRouterContext, elementType: LayoutRouterContext };
    const pageFiber = { return: ctx, type: Page, elementType: Page };
    const host = { return: pageFiber, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$x'] = host;

    expect(identify(el)?.componentStack).toEqual(['Page']);
  });

  it('keeps a USER component that merely ends in Provider/Context/Handler', () => {
    function CheckoutProvider(): null {
      return null;
    }
    const el = document.createElement('button');
    const root = { return: null, type: CheckoutProvider, elementType: CheckoutProvider };
    const host = { return: root, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$x'] = host;
    expect(identify(el)?.componentStack).toEqual(['CheckoutProvider']);
  });
});

function fiberEl(memoizedState: unknown): Element {
  const el = document.createElement('button');
  const componentFiber = {
    return: null,
    type: PayButton,
    elementType: PayButton,
    memoizedState,
  };
  const hostFiber = { return: componentFiber, type: 'button', elementType: 'button' };
  (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;
  return el;
}

describe('react adapter readState', () => {
  it('walks the memoizedState linked list into positional hook values', () => {
    const el = fiberEl({ memoizedState: 0, next: { memoizedState: 'x', next: null } });

    const result = readState(el);
    expect(result.ok).toBe(true);
    expect(result.component).toBe('PayButton');
    expect(result.hooks).toEqual([0, 'x']);
  });

  it('returns a structured failure for a host-only element with no fiber', () => {
    const result = readState(document.createElement('div'));
    expect(result).toEqual({ ok: false, reason: ComponentStateReason.UNAVAILABLE });
  });

  it('returns empty hooks when memoizedState is not an object (class/host)', () => {
    const result = readState(fiberEl(null));
    expect(result.ok).toBe(true);
    expect(result.component).toBe('PayButton');
    expect(result.hooks).toEqual([]);
  });

  it('caps a runaway/looping hook list', () => {
    const head: { memoizedState: number; next: unknown } = { memoizedState: 1, next: null };
    head.next = head; // self-referential loop
    const result = readState(fiberEl(head));
    expect(result.hooks?.length ?? 0).toBeLessThanOrEqual(100);
  });

  it('does not throw and stays JSON-serializable on circular hook state', () => {
    const circular: Record<string, unknown> = { label: 'state' };
    circular['self'] = circular; // cycle (fiber backref / reducer state shape)
    const result = readState(fiberEl({ memoizedState: circular, next: null }));
    expect(result.ok).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('sanitizes function and DOM-node hook values rather than serializing them raw', () => {
    const node = document.createElement('div');
    const el = fiberEl({
      memoizedState: () => undefined,
      next: { memoizedState: node, next: null },
    });
    const result = readState(el);
    expect(result.ok).toBe(true);
    expect(result.hooks?.[0]).toBeNull();
    expect(result.hooks?.[1]).not.toBe(node);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('returns a structured failure (no throw) when the fiber getter throws', () => {
    const el = document.createElement('button');
    Object.defineProperty(el, '__reactFiber$boom', {
      enumerable: true,
      get() {
        throw new Error('fiber explode');
      },
    });
    let result: ComponentStateResult | undefined;
    expect(() => {
      result = readState(el);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: ComponentStateReason.UNAVAILABLE });
  });
});

/**
 * React keeps TWO fibers per component (current and its `alternate`), and the `__reactFiber$…` key on
 * a host DOM node keeps pointing at the fiber object created at MOUNT — which is current on every
 * other commit and the previous commit's fiber the rest of the time. Reading it blind reports hook
 * state that is one commit behind, alternating correct/stale: DOM says 1, hooks say [0]; DOM says 2,
 * hooks say [2]. A verification tool that is silently one commit stale is worse than no tool.
 */
describe('react adapter readState reads the committed fiber, not its alternate', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function Counter(): ReturnType<typeof createElement> {
    const [count, setCount] = useState(0);
    return createElement(
      'button',
      { 'data-testid': 'inc', onClick: () => setCount(count + 1) },
      `${count}`,
    );
  }

  it('reports the hook value the DOM shows after every click, not the previous one', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(Counter)));
      const el = container.querySelector('[data-testid="inc"]');
      expect(el).not.toBeNull();
      if (null === el) return;

      for (let click = 1; click <= 4; click += 1) {
        act(() => {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(el.textContent).toBe(String(click));
        expect(readState(el).hooks, `after click ${click}`).toEqual([click]);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('react adapter hasHoverHandlers', () => {
  function withProps(props: unknown): Element {
    const el = document.createElement('button');
    const hostFiber = { return: null, type: 'button', elementType: 'button', memoizedProps: props };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;
    return el;
  }

  const handlerKeys = ['onMouseEnter', 'onMouseLeave', 'onPointerEnter', 'onPointerLeave'] as const;

  for (const key of handlerKeys) {
    it(`returns true when host props declare ${key}`, () => {
      expect(hasHoverHandlers(withProps({ [key]: () => undefined }))).toBe(true);
    });
  }

  it('returns false when only an unrelated handler is present', () => {
    expect(hasHoverHandlers(withProps({ onClick: () => undefined }))).toBe(false);
  });

  it('returns false for a plain element with no fiber', () => {
    expect(hasHoverHandlers(document.createElement('div'))).toBe(false);
  });

  it('returns false (fail-soft) when memoizedProps is null', () => {
    expect(hasHoverHandlers(withProps(null))).toBe(false);
  });

  it('returns false when a hover key is present but not a function', () => {
    expect(hasHoverHandlers(withProps({ onMouseEnter: 'nope' }))).toBe(false);
  });
});

/**
 * React's `_debugSource.fileName` is ABSOLUTE; the babel stamp is repo-relative. Both surface to the
 * agent as `source`, so the same product reported two different path shapes depending on which React
 * version an app happened to be on — three of six real apps came back with
 * `/private/tmp/.../wt/apps/x/src/A.tsx`, which is somebody else's machine and not a pointer anyone
 * can act on. The build plugins define the root; without one the path is left alone rather than guessed at.
 */
describe('source paths are repo-relative when the build plugin supplies a root', () => {
  const ROOT_KEY = '__RETICLE_ROOT__';
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g[ROOT_KEY];
  });

  function elementAt(fileName: string): Element {
    const el = document.createElement('button');
    const fiber = {
      return: null,
      type: function Pay() {
        return null;
      },
      elementType: function Pay() {
        return null;
      },
      _debugSource: { fileName, lineNumber: 7, columnNumber: 1 },
    };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = fiber;
    return el;
  }

  it('strips the root, with or without a trailing slash', () => {
    for (const root of ['/repo/app', '/repo/app/']) {
      g[ROOT_KEY] = root;
      expect(identify(elementAt('/repo/app/src/Pay.tsx'))?.source?.file).toBe('src/Pay.tsx');
    }
  });

  it('leaves the path alone when no root is defined — a guess would be worse', () => {
    expect(identify(elementAt('/repo/app/src/Pay.tsx'))?.source?.file).toBe(
      '/repo/app/src/Pay.tsx',
    );
  });

  it('leaves a path that is not under the root alone (linked package, monorepo sibling)', () => {
    g[ROOT_KEY] = '/repo/app';
    expect(identify(elementAt('/elsewhere/lib/Button.tsx'))?.source?.file).toBe(
      '/elsewhere/lib/Button.tsx',
    );
  });
});

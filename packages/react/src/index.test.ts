import { describe, it, expect } from 'vitest';
import { ComponentStateReason, type ComponentStateResult } from '@syrin/iris-protocol';
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

  it('returns a structured failure for a host-only element with no fiber (F5)', () => {
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

  it('sanitizes function and DOM-node hook values rather than serializing them raw (F5)', () => {
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

describe('react adapter hasHoverHandlers (F3)', () => {
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

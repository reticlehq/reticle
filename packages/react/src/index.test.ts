import { describe, it, expect } from 'vitest';
import { identify, readState } from './index.js';

interface HookStateResult {
  component?: string;
  hooks: unknown[];
}

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

describe('react adapter readState (G2 hook walk)', () => {
  it('walks the memoizedState linked list into positional hook values', () => {
    const el = document.createElement('button');
    const componentFiber = {
      return: null,
      type: PayButton,
      elementType: PayButton,
      memoizedState: { memoizedState: 0, next: { memoizedState: 'x', next: null } },
    };
    const hostFiber = { return: componentFiber, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;

    const result = readState(el) as HookStateResult;
    expect(result.component).toBe('PayButton');
    expect(result.hooks).toEqual([0, 'x']);
  });

  it('returns undefined for a host-only element with no fiber', () => {
    const el = document.createElement('div');
    expect(readState(el)).toBeUndefined();
  });

  it('returns empty hooks when memoizedState is not an object (class/host)', () => {
    const el = document.createElement('button');
    const componentFiber = {
      return: null,
      type: PayButton,
      elementType: PayButton,
      memoizedState: null,
    };
    const hostFiber = { return: componentFiber, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;

    const result = readState(el) as HookStateResult;
    expect(result.component).toBe('PayButton');
    expect(result.hooks).toEqual([]);
  });

  it('caps a runaway/looping hook list', () => {
    const el = document.createElement('button');
    const head: { memoizedState: number; next: unknown } = { memoizedState: 1, next: null };
    head.next = head; // self-referential loop
    const componentFiber = {
      return: null,
      type: PayButton,
      elementType: PayButton,
      memoizedState: head,
    };
    const hostFiber = { return: componentFiber, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;

    const result = readState(el) as HookStateResult;
    expect(result.hooks.length).toBeLessThanOrEqual(100);
  });
});

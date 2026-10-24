/**
 * Tests for the `discoverStores` option on `install()`.
 *
 * An app with multiple context providers holding state (e.g. Redux, TanStack Query)
 * had no way to prevent `install()` from discovering and auto-registering every store
 * it found in the React fiber tree (`redux`, `redux2`, etc.).
 *
 * `install({ discoverStores: false })` opts out of store discovery entirely while
 * keeping commit counting and the `__reticle_renders` store working.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createContext, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerStore, storeNames, unregisterStore } from '@reticlehq/browser';

let install: typeof import('./index.js').install;
let getRenderStats: typeof import('./index.js').getRenderStats;
let resetRenderMeter: typeof import('./index.js').resetRenderMeter;
let resetAutoStores: typeof import('./auto-stores.js').resetAutoStores;
let resetRenderMeterForTest: typeof import('./render-meter.js').resetRenderMeterForTest;

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
type AnyHook = {
  onCommitFiberRoot?: (...a: unknown[]) => void;
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: () => number;
  onScheduleFiberRoot?: () => void;
  onPostCommitFiberRoot?: () => void;
  onCommitFiberUnmount?: () => void;
};

async function resetState(): Promise<void> {
  vi.resetModules();
  const index = await import('./index.js');
  const autoStores = await import('./auto-stores.js');
  const renderMeter = await import('./render-meter.js');
  install = index.install;
  getRenderStats = index.getRenderStats;
  resetRenderMeter = index.resetRenderMeter;
  resetAutoStores = autoStores.resetAutoStores;
  resetRenderMeterForTest = renderMeter.resetRenderMeterForTest;

  document.body.innerHTML = '';
  delete (globalThis as unknown as Record<string, unknown>)[HOOK_KEY];
  resetRenderMeterForTest();
  resetAutoStores();
  for (const name of storeNames()) unregisterStore(name);
  resetRenderMeter();
}

function fireCommit(): void {
  const h = (globalThis as unknown as Record<string, AnyHook | undefined>)[HOOK_KEY];
  h?.onCommitFiberRoot?.();
}

function reduxLikeStore(): { getState: () => unknown; subscribe: () => () => void } {
  const state = { count: 0 };
  return {
    getState: () => state,
    subscribe: () => () => {},
  };
}

/** Mount a React tree with two separate context providers holding state. */
function mountTwoProviders(): void {
  const StoreContext1 = createContext<unknown>(null);
  StoreContext1.displayName = 'ReactRedux';
  const StoreContext2 = createContext<unknown>(null);
  StoreContext2.displayName = 'ReactRedux';

  const store1 = reduxLikeStore();
  const store2 = reduxLikeStore();

  function App(): ReactNode {
    return createElement(
      StoreContext1.Provider,
      { value: { store: store1 } },
      createElement(
        StoreContext2.Provider,
        { value: { store: store2 } },
        createElement('button', { 'data-testid': 'pay' }, 'Pay'),
      ),
    );
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(App)));
}

describe('install({ discoverStores: false })', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('provider stores are NOT registered after a commit when discoverStores is false', () => {
    install({ discoverStores: false });
    mountTwoProviders();
    fireCommit();

    expect(storeNames()).not.toContain('redux');
    expect(storeNames()).not.toContain('redux2');
  });

  it('an explicitly registered store IS registered and provider stores are excluded', () => {
    install({ discoverStores: false });
    const safeStore = reduxLikeStore();
    registerStore('safe', safeStore);

    mountTwoProviders();
    fireCommit();

    expect(storeNames()).toContain('safe');
    expect(storeNames()).not.toContain('redux');
    expect(storeNames()).not.toContain('redux2');
  });

  it('the render meter still counts commits when discoverStores is false', () => {
    install({ discoverStores: false });
    fireCommit();
    fireCommit();
    expect(getRenderStats().commits).toBe(2);
  });
});

describe('install({ discoverStores: true }) and default install()', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('provider stores ARE auto-registered when discoverStores is true (default)', () => {
    install();
    mountTwoProviders();
    fireCommit();

    expect(storeNames()).toContain('redux');
    expect(storeNames()).toContain('redux2');
  });

  it('provider stores appear alongside explicit stores when discoverStores is explicitly true', () => {
    install({ discoverStores: true });
    const safeStore = reduxLikeStore();
    registerStore('safe', safeStore);

    mountTwoProviders();
    fireCommit();

    expect(storeNames()).toContain('safe');
    expect(storeNames()).toContain('redux');
    expect(storeNames()).toContain('redux2');
  });

  it('the render meter counts commits on the default path', () => {
    install();
    fireCommit();
    fireCommit();
    expect(getRenderStats().commits).toBe(2);
  });
});

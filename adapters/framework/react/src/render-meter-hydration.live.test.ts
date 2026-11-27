/**
 * The render meter says when a real React page hydrated, also when it installs late (#1654).
 *
 * Next installs the adapter in a `useEffect`, after the shell committed. The signal used to wait for
 * the next commit, which never came on a quiet page, and it fired on a commit that left a slow
 * Suspense boundary without handlers. Replay reads `hydration` from the store to know what to wait
 * for, and waits only while it says `pending`.
 *
 * `commit()` below calls the hook by hand. `render-meter-react-hook.live.test.ts` lets React call it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createElement, Suspense, use, type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  HydrationState,
  RETICLE_HYDRATION_SIGNAL,
  RETICLE_RENDERS_STORE,
  RenderStatsField,
} from '@reticlehq/core';
import { readStores } from '@reticlehq/browser';
import { getRenderStats, installRenderMeter, resetRenderMeterForTest } from './render-meter.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

function Gate({ gate, children }: { gate: Promise<void> | undefined; children?: ReactNode }) {
  if (gate !== undefined) {
    use(gate);
  }
  return children;
}

function app(gate: Promise<void> | undefined): ReactNode {
  return createElement(
    Suspense,
    { fallback: createElement('p', null, 'loading') },
    createElement(Gate, { gate }, createElement('button', null, 'Reveal')),
  );
}

function hydrationInStore(): unknown {
  const stores = readStores(RETICLE_RENDERS_STORE) as Record<string, Record<string, unknown>>;
  return stores[RETICLE_RENDERS_STORE]?.[RenderStatsField.HYDRATION];
}

/** What React's commit hook does, so the test does not depend on when React reads the hook. */
function commit(): void {
  const hook = (
    globalThis as unknown as Record<string, { onCommitFiberRoot?: () => void } | undefined>
  )[HOOK_KEY];
  hook?.onCommitFiberRoot?.();
}

describe('render meter hydration over a real React tree', () => {
  let host: HTMLDivElement;
  const signal = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    signal.mockReset();
    resetRenderMeterForTest();
    (globalThis as Record<string, unknown>)['__reticleInstance'] = { signal };
  });

  it('signals at install when the page hydrated before the adapter loaded', () => {
    const root = createRoot(host);
    act(() => {
      root.render(app(undefined));
    });

    installRenderMeter({ discoverStores: false });

    expect(signal).toHaveBeenCalledWith(RETICLE_HYDRATION_SIGNAL);
    expect(getRenderStats().hydration).toBe(HydrationState.DONE);
    expect(hydrationInStore()).toBe(HydrationState.DONE);
  });

  // #1654 audit: the adapter is installed on pages with no React tree (a Preact app, an Astro page
  // without a React island, a static entry of a Vite app). The store said `hydrated: false` there
  // for ever, so replay waited its whole bound on every flow.
  it('says NONE, and does not signal, on a page with no React tree', () => {
    document.body.innerHTML = '<main><button>plain</button></main>';

    installRenderMeter({ discoverStores: false });

    expect(signal).not.toHaveBeenCalled();
    expect(hydrationInStore()).toBe(HydrationState.NONE);
  });

  it('waits for a dehydrated Suspense boundary, and signals on the commit that hydrates it', async () => {
    host.innerHTML = renderToString(app(undefined));
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await act(async () => {
      hydrateRoot(host, app(gate));
      await Promise.resolve();
    });

    installRenderMeter({ discoverStores: false });
    commit();
    expect(signal).not.toHaveBeenCalled();
    expect(hydrationInStore()).toBe(HydrationState.PENDING);

    await act(async () => {
      open();
      await gate;
    });
    commit();
    expect(signal).toHaveBeenCalledTimes(1);
    expect(hydrationInStore()).toBe(HydrationState.DONE);
  });
});

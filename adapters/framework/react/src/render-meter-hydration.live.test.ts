/**
 * The render meter says when a real React page hydrated, also when it installs late (#1654).
 *
 * Next installs the adapter in a `useEffect`, after the shell committed. The signal used to wait for
 * the next commit, which never came on a quiet page, and it fired on a commit that left a slow
 * Suspense boundary without handlers. Replay reads `hydrated` from the store to know what to wait for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createElement, Suspense, use, type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { RETICLE_HYDRATION_SIGNAL, RETICLE_RENDERS_STORE, RenderStatsField } from '@reticlehq/core';
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

function hydratedInStore(): unknown {
  const stores = readStores(RETICLE_RENDERS_STORE) as Record<string, Record<string, unknown>>;
  return stores[RETICLE_RENDERS_STORE]?.[RenderStatsField.HYDRATED];
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
    expect(getRenderStats().hydrated).toBe(true);
    expect(hydratedInStore()).toBe(true);
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
    expect(hydratedInStore()).toBe(false);

    await act(async () => {
      open();
      await gate;
    });
    commit();
    expect(signal).toHaveBeenCalledTimes(1);
    expect(hydratedInStore()).toBe(true);
  });
});

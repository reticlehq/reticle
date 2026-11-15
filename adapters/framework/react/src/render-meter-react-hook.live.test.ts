/**
 * React itself calls the adapter's commit hook, and the hydration signal follows it (#1654).
 *
 * The other hydration tests call the hook by hand, because react-dom reads
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` once, when it loads, and those files import it first. Here the
 * adapter installs its hook BEFORE react-dom loads, as the Vite plugin's pre-hook and Next's
 * react-refresh hook make it happen in a browser. So every commit below is one React made.
 *
 * The root's container is placed after more elements than the adapter scans for a root. Only the
 * root that React hands to the hook can then say that a boundary still waits. The first version read
 * the page instead, found nothing, and fired the signal on the first commit.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { act, createElement, Suspense, use, type ReactNode } from 'react';
import {
  HydrationState,
  RETICLE_HYDRATION_SIGNAL,
  RETICLE_RENDERS_STORE,
  RenderStatsField,
} from '@reticlehq/core';
import { readStores } from '@reticlehq/browser';
import { getRenderStats, installRenderMeter, resetRenderMeterForTest } from './render-meter.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
/** More elements than the adapter looks at for a root container. */
const FILLER_ELEMENTS = 300;

function Gate({ gate, children }: { gate: Promise<void> | undefined; children?: ReactNode }) {
  if (gate !== undefined) {
    use(gate);
  }
  return children;
}

function app(gate: Promise<void> | undefined): ReactNode {
  return createElement(
    'main',
    null,
    createElement(
      Suspense,
      { fallback: createElement('p', null, 'loading') },
      createElement(Gate, { gate }, createElement('button', null, 'Reveal')),
    ),
  );
}

function hydrationInStore(): unknown {
  const stores = readStores(RETICLE_RENDERS_STORE) as Record<string, Record<string, unknown>>;
  return stores[RETICLE_RENDERS_STORE]?.[RenderStatsField.HYDRATION];
}

describe('render meter hydration, driven by React through the commit hook', () => {
  const signal = vi.fn();

  beforeAll(() => {
    resetRenderMeterForTest();
    (globalThis as Record<string, unknown>)[HOOK_KEY] = undefined;
    (globalThis as Record<string, unknown>)['__reticleInstance'] = { signal };
    installRenderMeter({ discoverStores: false });
  });

  it('does not signal while a boundary is dehydrated, and signals once when React hydrates it', async () => {
    // Loaded only now, so React finds the adapter's hook when it evaluates.
    const { hydrateRoot } = await import('react-dom/client');
    const { renderToString } = await import('react-dom/server');
    document.body.innerHTML = '<div></div>'.repeat(FILLER_ELEMENTS);
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = renderToString(app(undefined));
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    await act(async () => {
      hydrateRoot(host, app(gate));
      await Promise.resolve();
    });

    expect(getRenderStats().commits).toBeGreaterThan(0);
    expect(signal).not.toHaveBeenCalled();
    expect(hydrationInStore()).toBe(HydrationState.PENDING);

    await act(async () => {
      open();
      await gate;
    });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(RETICLE_HYDRATION_SIGNAL);
    expect(hydrationInStore()).toBe(HydrationState.DONE);
  });
});

/**
 * The hydration state of a REAL React tree, server-rendered and then hydrated (#1654).
 *
 * The defect: a Next page committed its shell, and a Suspense boundary under it hydrated seconds
 * later. The boundary's server-rendered button had no handler until then, so a replayed click did
 * nothing. Only React's own fibers say which part still waits, so this test uses real React.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement, Suspense, use, type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { HydrationState, readHydrationState } from './hydration-state.js';

/** Suspends on the client until `gate` resolves. The server renders it at once. */
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
      createElement(Gate, { gate }, createElement('button', { 'data-testid': 'reveal' }, 'Reveal')),
    ),
  );
}

describe('readHydrationState over a real React tree', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('is NONE on server HTML that React has not touched', () => {
    host.innerHTML = renderToString(app(undefined));
    expect(readHydrationState(document)).toBe(HydrationState.NONE);
  });

  it('is PENDING while a Suspense boundary is dehydrated, then DONE when it hydrates', async () => {
    host.innerHTML = renderToString(app(undefined));
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    await act(async () => {
      hydrateRoot(host, app(gate));
      await Promise.resolve();
    });
    expect(readHydrationState(document)).toBe(HydrationState.PENDING);

    await act(async () => {
      open();
      await gate;
    });
    expect(readHydrationState(document)).toBe(HydrationState.DONE);
  });

  it('is DONE once a page that suspends nothing hydrates', async () => {
    host.innerHTML = renderToString(app(undefined));
    await act(async () => {
      hydrateRoot(host, app(undefined));
      await Promise.resolve();
    });
    expect(readHydrationState(document)).toBe(HydrationState.DONE);
  });

  it('is DONE after a client render, which has nothing to hydrate', () => {
    const root = createRoot(host);
    act(() => {
      root.render(app(undefined));
    });
    expect(readHydrationState(document)).toBe(HydrationState.DONE);
  });
});

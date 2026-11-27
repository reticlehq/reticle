/**
 * The hydration state of a REAL React tree, server-rendered and then hydrated (#1654).
 *
 * The defect: a Next page committed its shell, and a Suspense boundary under it hydrated seconds
 * later. The boundary's server-rendered button had no handler until then, so a replayed click did
 * nothing. Only React's own fibers say which part still waits, so this test uses real React.
 *
 * Each fallback must say "not sure" rather than "done": a DONE that is wrong sends replay into a
 * page without handlers, which is the defect itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement, Suspense, use, type ReactNode } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { HydrationState } from '@reticlehq/core';
import { MAX_HYDRATION_WALK, readHydrationState } from './hydration-state.js';

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

/** A gate and the function that opens it. */
function gated(): { gate: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

/** Server HTML in `host`, hydrated with a boundary that waits for `gate`. */
async function hydrateHeld(host: HTMLElement, gate: Promise<void>): Promise<Root> {
  host.innerHTML = renderToString(app(undefined));
  let root: Root | undefined;
  await act(async () => {
    root = hydrateRoot(host, app(gate));
    await Promise.resolve();
  });
  if (root === undefined) {
    throw new Error('hydrateRoot returned nothing');
  }
  return root;
}

/** The FiberRoot React keeps for `host`, as the commit hook would hand it to the adapter. */
function fiberRootOf(host: HTMLElement): unknown {
  const key = Object.keys(host).find((name) => name.startsWith('__reactContainer$'));
  const fiber = key === undefined ? undefined : (host as unknown as Record<string, unknown>)[key];
  return (fiber as { stateNode?: unknown } | undefined)?.stateNode;
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

  it('is NONE on a page with no React at all', () => {
    host.innerHTML = '<button>plain</button>';
    expect(readHydrationState(document)).toBe(HydrationState.NONE);
  });

  it('is PENDING while a Suspense boundary is dehydrated, then DONE when it hydrates', async () => {
    const { gate, open } = gated();
    await hydrateHeld(host, gate);
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

  // The first version read only the first root it found. A second root that still waits was missed.
  it('is PENDING when one root is hydrated and another still waits', async () => {
    const ready = createRoot(host);
    act(() => {
      ready.render(app(undefined));
    });
    const second = document.createElement('div');
    document.body.appendChild(second);
    const { gate } = gated();
    await hydrateHeld(second, gate);

    expect(readHydrationState(document)).toBe(HydrationState.PENDING);
  });

  // The first version looked for the root in the first 200 elements only. Past them, and with every
  // element of the root inside a dehydrated boundary, it read NONE, and the next commit fired the
  // signal while the boundary still had no handlers.
  it('reads a root that the commit hook named, wherever its container is', async () => {
    const filler = document.createElement('div');
    filler.innerHTML = '<span></span>'.repeat(300);
    document.body.insertBefore(filler, host);
    const { gate, open } = gated();
    await hydrateHeld(host, gate);
    const root = fiberRootOf(host);

    expect(readHydrationState(document)).not.toBe(HydrationState.DONE);
    expect(readHydrationState(document, [root])).toBe(HydrationState.PENDING);

    await act(async () => {
      open();
      await gate;
    });
    expect(readHydrationState(document, [root])).toBe(HydrationState.DONE);
  });

  // The walk has a cap so that a strange fiber graph cannot hang the app. A tree it could not read to
  // the end used to read DONE.
  it('is UNKNOWN, not DONE, when the tree is larger than one read may visit', () => {
    let child: Record<string, unknown> | null = null;
    for (let i = 0; i <= MAX_HYDRATION_WALK; i += 1) {
      child = { tag: 5, child };
    }
    const root = { current: { tag: 3, memoizedState: {}, child }, containerInfo: host };

    expect(readHydrationState(document, [root])).toBe(HydrationState.UNKNOWN);
  });

  it('is UNKNOWN, not DONE, when a fiber cannot be read', () => {
    const root = {
      containerInfo: host,
      get current(): unknown {
        throw new Error('not a fiber this adapter knows');
      },
    };

    expect(readHydrationState(document, [root])).toBe(HydrationState.UNKNOWN);
  });
});

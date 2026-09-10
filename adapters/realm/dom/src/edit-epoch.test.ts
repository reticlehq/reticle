import { describe, expect, it, beforeEach } from 'vitest';
import { NO_EDITS_OBSERVED } from '@reticlehq/core';
import { EditEpoch } from './edit-epoch.js';
import { RefRegistry } from './dom/refs.js';

/**
 * A stale ref after a hot update must SAY the code changed underneath it.
 *
 * The agent that drives Reticle now edits source and re-verifies in a loop. When it edits, the
 * framework re-renders and every ref it holds points at a detached node — but there was no
 * navigation, so nothing distinguished that from an ordinary app-side disappearance. The refusal
 * said "stale", the agent re-queried, and it could not tell its own edit landing from a bug.
 */

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A hot-update channel of the shape Vite's `import.meta.hot` has, with no Vite in the room. */
function fakeHot(): {
  on: (event: string, cb: (payload: unknown) => void) => void;
  fire: (payload: unknown) => void;
} {
  const listeners: ((payload: unknown) => void)[] = [];
  return {
    on: (_event, cb) => listeners.push(cb),
    fire: (payload) => listeners.forEach((cb) => cb(payload)),
  };
}

function mintedRef(registry: RefRegistry): string {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return registry.refFor(el);
}

describe('EditEpoch without a hot-update channel', () => {
  it('degrades to "no edits observed" rather than claiming none happened', () => {
    const epoch = new EditEpoch(new RefRegistry());
    epoch.observe(undefined);
    epoch.observe({ notAHotContext: true });
    expect(epoch.current).toBe(NO_EDITS_OBSERVED);
  });

  it('leaves the stale-ref refusal exactly as it was', () => {
    const registry = new RefRegistry();
    const epoch = new EditEpoch(registry);
    const ref = mintedRef(registry);
    expect(epoch.staleRefMessage(ref)).toBe(`ref '${ref}' no longer resolves to an element`);
  });
});

describe('EditEpoch with a hot-update channel', () => {
  it('advances when a hot update is applied', () => {
    const registry = new RefRegistry();
    const epoch = new EditEpoch(registry);
    const hot = fakeHot();
    epoch.observe(hot);
    hot.fire({ type: 'update', updates: [{ path: '/src/TripCard.tsx' }] });
    expect(epoch.current).toBe(NO_EDITS_OBSERVED + 1);
    hot.fire({ type: 'update', updates: [{ path: '/src/TripCard.tsx' }] });
    expect(epoch.current).toBe(NO_EDITS_OBSERVED + 2);
  });

  it('names the file that changed in the refusal for a ref minted before the update', () => {
    const registry = new RefRegistry();
    const epoch = new EditEpoch(registry);
    const hot = fakeHot();
    epoch.observe(hot);
    const ref = mintedRef(registry);
    hot.fire({ type: 'update', updates: [{ path: '/src/TripCard.tsx' }] });
    const message = epoch.staleRefMessage(ref);
    // The substring the server's recovery table keys off must survive, or a diagnosed stale ref
    // arrives classified as a possible Reticle defect.
    expect(message).toContain('no longer resolves to an element');
    expect(message).toContain('the code changed underneath it');
    expect(message).toContain('/src/TripCard.tsx');
  });

  it('still says the code changed when the update named no files', () => {
    const registry = new RefRegistry();
    const epoch = new EditEpoch(registry);
    const hot = fakeHot();
    epoch.observe(hot);
    const ref = mintedRef(registry);
    hot.fire({ type: 'update', updates: [] });
    expect(epoch.staleRefMessage(ref)).toContain('the code changed underneath it');
  });

  it('leaves a ref minted AFTER the update alone', () => {
    // The ordinary post-click stale ref, which has nothing to do with an edit. Blaming the last hot
    // update for it would be a confident wrong diagnosis — worse than the generic message it replaced.
    const registry = new RefRegistry();
    const epoch = new EditEpoch(registry);
    const hot = fakeHot();
    epoch.observe(hot);
    const before = mintedRef(registry);
    hot.fire({ type: 'update', updates: [{ path: '/src/TripCard.tsx' }] });
    const after = mintedRef(registry);
    expect(epoch.staleRefMessage(after)).toBe(`ref '${after}' no longer resolves to an element`);
    // The same registry, the same update, the other side of the boundary — so the test fails if the
    // boundary is not actually being consulted.
    expect(epoch.staleRefMessage(before)).toContain('the code changed underneath it');
  });

  it('does not blame an edit for a ref that was never minted here', () => {
    const registry = new RefRegistry();
    const epoch = new EditEpoch(registry);
    const hot = fakeHot();
    epoch.observe(hot);
    mintedRef(registry);
    hot.fire({ type: 'update', updates: [{ path: '/src/TripCard.tsx' }] });
    expect(epoch.staleRefMessage('not-a-ref')).toBe(
      "ref 'not-a-ref' no longer resolves to an element",
    );
  });
});

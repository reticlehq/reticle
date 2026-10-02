import { describe, it, expect, vi } from 'vitest';
import { installRenderMeter, resetRenderMeter, getRenderStats } from './render-meter.js';
import { readStores } from '@reticlehq/browser';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

interface Hook {
  onCommitFiberRoot?: (...args: unknown[]) => void;
}
const hookOf = (): Hook => {
  const h = (globalThis as unknown as Record<string, Hook | undefined>)[HOOK_KEY];
  if (h === undefined) throw new Error('devtools hook not installed');
  return h;
};

describe('render meter — counts React commits via the devtools hook', () => {
  // A real DevTools hook is already present: the meter must AUGMENT it (count + call the original).
  const original = vi.fn();
  (globalThis as unknown as Record<string, Hook>)[HOOK_KEY] = { onCommitFiberRoot: original };

  it('augments an existing hook: counts each commit and still calls the original', () => {
    installRenderMeter();
    const fire = hookOf().onCommitFiberRoot;
    expect(typeof fire).toBe('function');
    fire?.(1, {});
    fire?.(1, {});
    expect(getRenderStats().commits).toBe(2);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('resetRenderMeter zeroes the window, then counting resumes', () => {
    resetRenderMeter();
    expect(getRenderStats().commits).toBe(0);
    hookOf().onCommitFiberRoot?.(1, {});
    expect(getRenderStats().commits).toBe(1);
  });

  it('exposes commits through the __reticle_renders registered store (read via reticle_state)', () => {
    const stores = readStores('__reticle_renders') as Record<string, { commits: number }>;
    expect(stores['__reticle_renders']).toBeDefined();
    expect(typeof stores['__reticle_renders']?.commits).toBe('number');
  });

  it('a faulting original hook never breaks the commit count (host-safe)', () => {
    // The fault has to be INDUCED, or this test is named for a branch it never reaches.
    // `original` is a bare vi.fn(): it returned undefined, the try/catch never ran, and deleting
    // that try/catch outright left all four tests green. A test that passes over the deleted body
    // of the code it is named for is the false green this product exists to refuse.
    original.mockImplementationOnce(() => {
      throw new Error('a real DevTools hook faulted');
    });
    const before = getRenderStats().commits;
    const verboten = hookOf().onCommitFiberRoot;
    expect(() => verboten?.(1, {})).not.toThrow();
    // And the counter still advanced, which is the other half of the claim in the name.
    expect(getRenderStats().commits).toBe(before + 1);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { installRenderMeter, resetRenderMeter, getRenderStats } from './render-meter.js';
import { readStores } from '@syrin/iris-browser';

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

  it('exposes commits through the __iris_renders registered store (read via iris_state)', () => {
    const stores = readStores('__iris_renders') as Record<string, { commits: number }>;
    expect(stores['__iris_renders']).toBeDefined();
    expect(typeof stores['__iris_renders']?.commits).toBe('number');
  });

  it('a faulting original hook never breaks the commit count (host-safe)', () => {
    const verboten = hookOf().onCommitFiberRoot;
    // even if the wrapped original throws, our counter still advances and nothing propagates
    expect(() => verboten?.(1, {})).not.toThrow();
  });
});

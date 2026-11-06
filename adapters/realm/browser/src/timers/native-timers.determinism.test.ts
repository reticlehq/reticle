import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETERMINISM_GLOBAL_KEY } from '@reticlehq/core';

// A deterministic lease replaces the page's timers before the SDK loads. If the SDK bound those,
// its own waits, reconnects and heartbeat would stop with the page's clock. The lease keeps the real
// timers under a shared key, and the SDK must take them from there.

const key = Symbol.for(DETERMINISM_GLOBAL_KEY);
const holder = globalThis as unknown as Record<symbol, unknown>;

describe('native timers under a deterministic lease', () => {
  afterEach(() => {
    Reflect.deleteProperty(holder, key);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the real timers the lease kept, not the stepped ones in the page', async () => {
    const realNow = (): number => 4242;
    holder[key] = {
      natives: {
        setTimeout,
        clearTimeout,
        requestAnimationFrame: undefined,
        performanceNow: realNow,
      },
    };
    // The page's own timers stand still, as the deterministic clock does until a step.
    vi.stubGlobal('setTimeout', (): number => 0);
    vi.stubGlobal('performance', { now: (): number => 0 });
    vi.resetModules();
    const { nativeNow, nativeSetTimeout } = await import('./native/native-timers.js');
    expect(nativeNow()).toBe(4242);
    await new Promise<void>((resolve) => {
      nativeSetTimeout(resolve, 1);
    });
  });
});

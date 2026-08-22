import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// boundedFrame must ALWAYS resolve — it races real rAF against a nativeSetTimeout fallback.
// In a throttled/background tab rAF never fires, so the fallback wins and reports settled:false.

describe('boundedFrame is bounded — never hangs', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves with { settled: false } when rAF never fires', async () => {
    vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback): number => 1);
    const { boundedFrame } = await import('./native-timers.js');

    const outcome = await boundedFrame(50);

    // `settled: false` is the whole property: the bound was reached and the call resolved
    // instead of hanging on a rAF that never fires. A wall-clock comparison restated that
    // as a fact about the runner, which is the one way it could fail without the code
    // being wrong.
    expect(outcome.settled).toBe(false);
  });

  it('resolves with { settled: true } when rAF fires normally', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    const { boundedFrame } = await import('./native-timers.js');

    const outcome = await boundedFrame(200);
    expect(outcome.settled).toBe(true);
  });
});

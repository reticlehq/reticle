import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// executeAction must separate dispatch from settle. A settle that never lands a real frame
// (throttled/background tab where rAF never fires) must NOT reject and must NOT hang — it resolves
// with dispatched:true, settled:false, settleReason:'timeout'. A real dispatch failure still rejects.

describe('settle is bounded — never hangs on a throttled rAF', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves executeAction(click) with dispatched:true, settled:false when rAF never fires', async () => {
    // rAF that NEVER invokes its callback — the background-tab failure mode.
    vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback): number => 1);
    // Re-import so native-timers captures the stubbed rAF at module load.
    const { executeAction } = await import('./actions.js');
    const { refs } = await import('../dom/refs.js');

    document.body.innerHTML = '<button>Save</button>';
    const el = document.querySelector('button');
    if (el === null) throw new Error('no button');
    const ref = refs.refFor(el);

    const start = Date.now();
    const r = await executeAction(ref, 'click'); // must RESOLVE, not reject/hang
    const elapsed = Date.now() - start;

    expect(r.dispatched).toBe(true);
    expect(r.effect.dispatched).toBe(true);
    expect(r.settled).toBe(false);
    expect(r.settleReason).toBe('timeout');
    expect(elapsed).toBeLessThan(2000); // well under the 8s server timeout, ~200ms bound
  }, 5000);

  it('still rejects on a stale ref even when rAF never fires', async () => {
    vi.stubGlobal('requestAnimationFrame', (): number => 1);
    const { executeAction } = await import('./actions.js');
    const { refs } = await import('../dom/refs.js');
    document.body.innerHTML = '<button>gone</button>';
    const el = document.querySelector('button');
    if (el === null) throw new Error('no button');
    const ref = refs.refFor(el);
    document.body.innerHTML = ''; // detach → requireElement throws
    await expect(executeAction(ref, 'click')).rejects.toThrow();
  }, 5000);

  it('surfaces per-step settled:false in executeSequence when rAF never fires', async () => {
    vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback): number => 1);
    const { executeSequence } = await import('./actions.js');
    const { refs } = await import('../dom/refs.js');

    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const a = document.querySelector('#a');
    const b = document.querySelector('#b');
    if (a === null || b === null) throw new Error('missing buttons');
    const refA = refs.refFor(a);
    const refB = refs.refFor(b);

    const res = await executeSequence([
      { ref: refA, action: 'click' },
      { ref: refB, action: 'click' },
    ]);

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.effects.every((e) => e.dispatched === true)).toBe(true);
    expect(res.steps.every((s) => s.dispatched === true)).toBe(true);
    expect(res.steps.every((s) => s.settled === false)).toBe(true);
    expect(res.steps.every((s) => s.settleReason === 'timeout')).toBe(true);
  }, 5000);
});

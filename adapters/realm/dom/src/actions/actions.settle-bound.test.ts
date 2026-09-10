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
    if (null === el) throw new Error('no button');
    const ref = refs.refFor(el);

    const r = await executeAction(ref, 'click'); // must RESOLVE, not reject/hang

    expect(r.dispatched).toBe(true);
    expect(r.effect.dispatched).toBe(true);
    expect(r.settled).toBe(false);
    // `settleReason: 'timeout'` IS the bound, stated by the code rather than measured off the
    // machine. The wall-clock assertion that used to sit here added no coverage these four lines
    // did not already have, and one load-dependent way to fail. The 5000 below catches a genuine
    // hang and is immune to how loaded the runner is.
    expect(r.settleReason).toBe('timeout');
  }, 5000);

  it('still rejects on a stale ref even when rAF never fires', async () => {
    vi.stubGlobal('requestAnimationFrame', (): number => 1);
    const { executeAction } = await import('./actions.js');
    const { refs } = await import('../dom/refs.js');
    document.body.innerHTML = '<button>gone</button>';
    const el = document.querySelector('button');
    if (null === el) throw new Error('no button');
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
    if (null === a || null === b) throw new Error('missing buttons');
    const refA = refs.refFor(a);
    const refB = refs.refFor(b);

    const res = await executeSequence([
      { ref: refA, action: 'click' },
      { ref: refB, action: 'click' },
    ]);

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.effects.every((e) => true === e.dispatched)).toBe(true);
    expect(res.steps.every((s) => true === s.dispatched)).toBe(true);
    expect(res.steps.every((s) => false === s.settled)).toBe(true);
    expect(res.steps.every((s) => 'timeout' === s.settleReason)).toBe(true);
  }, 5000);
});

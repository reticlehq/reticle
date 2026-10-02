import { describe, it, expect, afterEach } from 'vitest';
import { EventType, BlindSpotKind } from '@reticlehq/core';
import { isCrossOriginFrame, countCrossOriginFrames } from './blind-spots.js';
import type { Emit, Teardown } from './types.js';

/** A minimal iframe stand-in — enough surface for the pure predicate. */
function frame(
  src: string | null,
  contentDocument: unknown,
  throwOnAccess = false,
): HTMLIFrameElement {
  return {
    getAttribute: (n: string) => ('src' === n ? src : null),
    get contentDocument() {
      if (throwOnAccess) throw new DOMException('cross-origin');
      return contentDocument as Document | null;
    },
  } as unknown as HTMLIFrameElement;
}

describe('isCrossOriginFrame', () => {
  it('flags a src-bearing frame whose contentDocument is null (cross-origin)', () => {
    expect(isCrossOriginFrame(frame('https://pay.stripe.com', null))).toBe(true);
  });

  it('flags a frame that throws on contentDocument access (SecurityError)', () => {
    expect(isCrossOriginFrame(frame('https://other.example', null, true))).toBe(true);
  });

  it('does NOT flag a same-origin frame (contentDocument present)', () => {
    expect(isCrossOriginFrame(frame('/local.html', {}))).toBe(false);
  });

  it('does NOT flag a srcless / about:blank frame (same-origin, just not navigated)', () => {
    expect(isCrossOriginFrame(frame(null, null))).toBe(false);
    expect(isCrossOriginFrame(frame('', null))).toBe(false);
  });
});

describe('countCrossOriginFrames', () => {
  it('counts only the cross-origin frames in a list', () => {
    const frames = [
      frame('https://pay.stripe.com', null),
      frame('/local.html', {}),
      frame('https://widget.other', null, true),
    ];
    expect(countCrossOriginFrames(frames)).toBe(2);
  });
});

describe('installBlindSpots', () => {
  let teardown: Teardown | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits BLIND_SPOT once on install when a cross-origin frame is present', async () => {
    // jsdom doesn't fetch, so a foreign-src iframe still exposes a same-origin blank doc — we can't get a
    // real cross-origin frame here. Stub querySelectorAll to hand the sensor a genuinely-foreign frame.
    const foreign = frame('https://pay.stripe.com', null);
    const original = document.querySelectorAll.bind(document);
    document.querySelectorAll = ((sel: string) =>
      'iframe' === sel ? [foreign] : original(sel)) as typeof document.querySelectorAll;

    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    const emit: Emit = (type, data) => events.push({ type, data });
    try {
      const { installBlindSpots } = await import('./blind-spots.js');
      teardown = installBlindSpots(emit);
      const spots = events.filter((e) => e.type === EventType.BLIND_SPOT);
      expect(spots).toHaveLength(1); // reported once, not per-mutation
      expect(spots[0]?.data['kind']).toBe(BlindSpotKind.CROSS_ORIGIN_IFRAME);
      expect(spots[0]?.data['count']).toBe(1);
    } finally {
      document.querySelectorAll = original;
    }
  });

  /**
   * The mutation path re-checks on a debounce rather than inspecting each mutated node. The old code
   * gated on `addedNode.querySelector('iframe')`, which cost a full subtree scan per mutated node —
   * more expensive than the document scan it was avoiding, and scaling with the size of whatever the
   * app just rendered. These two tests pin the behaviour that made coalescing safe to adopt: a frame
   * appearing later is still reported, and unrelated churn reports nothing.
   */
  it('reports a cross-origin frame that appears AFTER install', async () => {
    let frames: HTMLIFrameElement[] = [];
    const original = document.querySelectorAll.bind(document);
    document.querySelectorAll = ((sel: string) =>
      'iframe' === sel ? frames : original(sel)) as typeof document.querySelectorAll;

    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    const emit: Emit = (type, data) => events.push({ type, data });
    try {
      const { installBlindSpots } = await import('./blind-spots.js');
      teardown = installBlindSpots(emit);
      expect(events.filter((e) => e.type === EventType.BLIND_SPOT)).toHaveLength(0);

      frames = [frame('https://pay.stripe.com', null)];
      document.body.appendChild(document.createElement('div')); // any childList mutation

      // Poll rather than sleep a fixed margin past the debounce. A fixed wait races the debounce on a
      // loaded machine, and a timing test that fails under parallel load teaches people to re-run the
      // suite instead of reading it.
      const deadline = Date.now() + 5000;
      while (
        0 === events.filter((e) => e.type === EventType.BLIND_SPOT).length &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const spots = events.filter((e) => e.type === EventType.BLIND_SPOT);
      expect(spots).toHaveLength(1);
      expect(spots[0]?.data['count']).toBe(1);
    } finally {
      document.querySelectorAll = original;
    }
  });

  it('stays silent when the DOM churns but no frame appears', async () => {
    const original = document.querySelectorAll.bind(document);
    document.querySelectorAll = ((sel: string) =>
      'iframe' === sel ? [] : original(sel)) as typeof document.querySelectorAll;

    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    const emit: Emit = (type, data) => events.push({ type, data });
    try {
      const { installBlindSpots } = await import('./blind-spots.js');
      teardown = installBlindSpots(emit);
      for (let i = 0; i < 50; i += 1) document.body.appendChild(document.createElement('span'));
      // A negative assertion has to wait out the window rather than poll — there is nothing to poll for.
      await new Promise((r) => setTimeout(r, 1000));
      expect(events.filter((e) => e.type === EventType.BLIND_SPOT)).toHaveLength(0);
    } finally {
      document.querySelectorAll = original;
    }
  });
});

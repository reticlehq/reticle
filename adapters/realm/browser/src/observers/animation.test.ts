import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installAnimation } from './animation.js';
import type { Emit } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

/** jsdom lacks AnimationEvent/TransitionEvent constructors — synthesize the props the observer reads. */
function fireAnim(
  el: Element,
  type: 'animationstart' | 'animationend',
  animationName: string,
): void {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { animationName });
  el.dispatchEvent(e);
}

function fireTransitionEnd(el: Element, propertyName: string): void {
  const e = new Event('transitionend', { bubbles: true });
  Object.assign(e, { propertyName });
  el.dispatchEvent(e);
}

describe('animation observer: overlay self-pollution', () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits anim.start for a normal app element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { emit, events } = collect();
    teardown = installAnimation(emit);

    fireAnim(el, 'animationstart', 'fade');

    expect(events.map((e) => e.type)).toContain(EventType.ANIM_START);
  });

  it('does NOT emit for an element inside the Reticle presenter overlay', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-reticle-overlay', '');
    const row = document.createElement('div');
    overlay.appendChild(row);
    document.body.appendChild(overlay);
    const { emit, events } = collect();
    teardown = installAnimation(emit);

    // The HUD's own reticle-pulse/reticle-shimmer keyframes used to flood observed timelines.
    fireAnim(row, 'animationstart', 'reticle-pulse');
    fireAnim(row, 'animationend', 'reticle-pulse');
    fireTransitionEnd(row, 'opacity');

    expect(events).toHaveLength(0);
  });

  it('still emits transitionend for a normal app element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { emit, events } = collect();
    teardown = installAnimation(emit);

    fireTransitionEnd(el, 'height');

    expect(events.map((e) => e.type)).toContain(EventType.ANIM_END);
  });

  it('stops emitting after teardown', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { emit, events } = collect();
    teardown = installAnimation(emit);
    teardown();
    teardown = undefined;
    events.length = 0;

    fireAnim(el, 'animationstart', 'fade');
    fireAnim(el, 'animationend', 'fade');
    fireTransitionEnd(el, 'opacity');

    expect(events).toHaveLength(0);
  });
});

// #2484: a fade that a script runs with `el.animate()` (the Web Animations API, used by Motion)
// fires no animationstart or animationend. The check then found no event and answered no.
describe('installAnimation: Web Animations API', () => {
  type Animate = (this: Element, ...args: unknown[]) => unknown;
  const proto = Element.prototype as unknown as { animate?: Animate };
  const had = Object.prototype.hasOwnProperty.call(proto, 'animate');
  const original = proto.animate;
  let finish: () => void = () => undefined;

  beforeEach(() => {
    proto.animate = function fakeAnimate(): unknown {
      return {
        id: '',
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
    };
  });
  afterEach(() => {
    if (had && original !== undefined) {
      proto.animate = original;
    } else {
      delete proto.animate;
    }
    document.body.innerHTML = '';
  });

  it('emits a start when el.animate() runs and an end when it finishes', async () => {
    const { emit, events } = collect();
    const teardown = installAnimation(emit);
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.animate([{ opacity: 0 }, { opacity: 1 }], 200);
    expect(events.map((e) => [e.type, e.data['kind']])).toEqual([[EventType.ANIM_START, 'waapi']]);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.map((e) => e.type)).toEqual([EventType.ANIM_START, EventType.ANIM_END]);
    teardown();
  });

  it('restores el.animate on teardown, unless something wrapped it after', () => {
    const before = proto.animate;
    const teardown = installAnimation(collect().emit);
    expect(proto.animate).not.toBe(before);
    teardown();
    expect(proto.animate).toBe(before);
  });
});

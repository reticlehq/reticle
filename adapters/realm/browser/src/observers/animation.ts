import { EventType } from '@reticlehq/core/page';
import { refs } from '@/dom/addressing/refs.js';
import { isReticleOverlay } from '@/dom/dom-ignore.js';
import { captureMethod } from '@/patching/capture-method.js';
import { observeSafely, type Emit, type Teardown } from './types.js';

/** The `kind` of an animation that a script started with `el.animate()`. */
const WAAPI_KIND = 'waapi';
/** The name of a script animation that has no `id`. */
const WAAPI_NAME = 'animate';

type Animate = (this: Element, ...args: unknown[]) => Animation;

/**
 * Report an animation that a script starts with `el.animate()` (#2484). The Web Animations API
 * fires no animationstart or animationend, so a fade that Motion runs left no event, and the
 * animation check answered no. Returns the teardown, or undefined where the page has no `animate`.
 */
function patchAnimate(emit: Emit): Teardown | undefined {
  const proto = Element.prototype as unknown as { animate?: Animate };
  if ('function' !== typeof proto.animate) {
    return undefined;
  }
  const original = captureMethod(proto as Record<'animate', Animate>, 'animate');
  const patched = function reticleObservedAnimate(this: Element, ...args: unknown[]): Animation {
    const animation = original.apply(this, args);
    observeSafely(() => {
      if (isReticleOverlay(this)) {
        return;
      }
      const ref = refs.refFor(this);
      const data = { name: '' === animation.id ? WAAPI_NAME : animation.id, kind: WAAPI_KIND };
      emit(EventType.ANIM_START, data, ref);
      // A cancelled animation rejects `finished`: it did not end, so it emits nothing.
      animation.finished.then(
        () => {
          observeSafely(() => {
            emit(EventType.ANIM_END, data, ref);
          });
        },
        () => undefined,
      );
    });
    return animation;
  };
  proto.animate = patched;
  return () => {
    // Restore only our own wrapper: something that wrapped `animate` after us keeps its slot.
    if (proto.animate === patched) {
      proto.animate = original;
    }
  };
}

/** Observe CSS animations, transitions and `el.animate()`, and emit anim.start / anim.end. */
export function installAnimation(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;

  const onStart = (event: AnimationEvent): void => {
    const target = event.target;
    // Skip Reticle's own HUD keyframes (reticle-pulse/reticle-shimmer/…) so observe/record never
    // self-pollute the agent's view of the app (matches the DOM observer's overlay filter).
    if (target instanceof Element && !isReticleOverlay(target)) {
      emit(EventType.ANIM_START, { name: event.animationName }, refs.refFor(target));
    }
  };
  const onEnd = (event: AnimationEvent): void => {
    const target = event.target;
    if (target instanceof Element && !isReticleOverlay(target)) {
      emit(EventType.ANIM_END, { name: event.animationName }, refs.refFor(target));
    }
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    const target = event.target;
    if (target instanceof Element && !isReticleOverlay(target)) {
      emit(
        EventType.ANIM_END,
        { name: event.propertyName, kind: 'transition' },
        refs.refFor(target),
      );
    }
  };

  document.addEventListener('animationstart', onStart, { capture: true, signal });
  document.addEventListener('animationend', onEnd, { capture: true, signal });
  document.addEventListener('transitionend', onTransitionEnd, { capture: true, signal });

  const unpatch = patchAnimate(emit);

  return () => {
    ac.abort();
    unpatch?.();
  };
}

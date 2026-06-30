import { EventType } from '@reticlehq/protocol';
import { refs } from '../dom/refs.js';
import { isReticleOverlay } from '../dom/dom-ignore.js';
import type { Emit, Teardown } from './types.js';

/** Observe CSS animations + transitions and emit anim.start / anim.end (plan/03 §6). */
export function installAnimation(emit: Emit): Teardown {
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

  document.addEventListener('animationstart', onStart, true);
  document.addEventListener('animationend', onEnd, true);
  document.addEventListener('transitionend', onTransitionEnd, true);

  return () => {
    document.removeEventListener('animationstart', onStart, true);
    document.removeEventListener('animationend', onEnd, true);
    document.removeEventListener('transitionend', onTransitionEnd, true);
  };
}

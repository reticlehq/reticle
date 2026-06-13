import { EventType } from '@iris/protocol';
import { refs } from '../refs.js';
import type { Emit, Teardown } from './types.js';

const THROTTLE_MS = 100;
const REVEAL_SELECTOR = '[data-iris-reveal], [data-reveal], section';

/** Observe scroll position + reveal-on-scroll for modern scroll-reactive UIs (plan/03 §8). */
export function installScroll(emit: Emit): Teardown {
  let lastEmit = 0;
  let lastY = 0;

  const onScroll = (): void => {
    const now = performance.now();
    if (now - lastEmit < THROTTLE_MS) return;
    lastEmit = now;
    const y = window.scrollY;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    emit(EventType.SCROLL_POSITION, {
      x: window.scrollX,
      y,
      percent: Math.round((y / max) * 100),
      direction: y >= lastY ? 'down' : 'up',
    });
    lastY = y;
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  let io: IntersectionObserver | undefined;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            emit(
              EventType.REVEAL_SHOWN,
              { ratio: entry.intersectionRatio },
              refs.refFor(entry.target),
            );
          }
        }
      },
      { threshold: 0.25 },
    );
    for (const el of document.querySelectorAll(REVEAL_SELECTOR)) io.observe(el);
  }

  return () => {
    window.removeEventListener('scroll', onScroll);
    io?.disconnect();
  };
}

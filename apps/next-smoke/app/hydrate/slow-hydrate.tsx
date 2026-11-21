'use client';
import { use, type ReactNode } from 'react';

const DELAY_PARAM = 'delay';
/** `?delay=click`: hold until the first click anywhere, so the page hydrates just after a click. */
const UNTIL_CLICK = 'click';
let gate: Promise<void> | undefined;

/** The client's hold on hydration, from `?delay=<ms>` or `?delay=click`. The server never holds. */
function clientGate(): Promise<void> | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const param = new URLSearchParams(window.location.search).get(DELAY_PARAM);
  if (param === UNTIL_CLICK) {
    gate ??= new Promise((resolve) => {
      document.addEventListener('click', () => resolve(), { once: true, capture: true });
    });
    return gate;
  }
  const delay = Number(param ?? '0');
  if (!Number.isFinite(delay) || delay <= 0) {
    return undefined;
  }
  gate ??= new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
  return gate;
}

/** Suspends its subtree on the client until the delay ends, so the boundary stays dehydrated. */
export function SlowHydrate({ children }: { children: ReactNode }) {
  const pending = clientGate();
  if (pending !== undefined) {
    use(pending);
  }
  return children;
}

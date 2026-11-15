'use client';
import { use, type ReactNode } from 'react';

const DELAY_PARAM = 'delay';
let gate: Promise<void> | undefined;

/** The client's hold on hydration, from `?delay=<ms>`. The server never holds. */
function clientGate(): Promise<void> | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const delay = Number(new URLSearchParams(window.location.search).get(DELAY_PARAM) ?? '0');
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

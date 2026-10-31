/**
 * The page-error side of a lease: listen for the throws the SDK will never see, and tell the
 * wiring when the lease is gone.
 *
 * An app whose module graph throws during the first navigation fires its `error` event while the
 * page still has no Reticle SDK in it — the zero-install reader is only evaluated after `goto`
 * resolves — so nothing on the page records it, and a blank page reported as a bare console-error
 * count (#1966). The server's Playwright handle is attached before the navigation, so it is the
 * one witness that cannot miss the throw. This module owns that wiring for `BrowserPool`; the
 * journal that buffers and journals what arrives lives in `page-error-journal.ts`.
 */
import { RETICLE_EARLY_CAPTURE } from '@reticlehq/core';
import type { PooledPage, PooledPageError } from './pool-contract.js';

/** The page-error hooks `BrowserPoolOptions` carries, forwarded here verbatim. */
export interface LeasePageErrorHooks {
  onPageError?: ((leaseId: string, error: PooledPageError) => void) | undefined;
  onLeaseClosed?: ((leaseId: string) => void) | undefined;
}

/**
 * Install the lease's uncaught-error listener and its early console queue. Call BEFORE the first
 * navigation — the timing is the whole fix: an import-time throw lands during `goto`, and one
 * attached after it reads a broken page as healthy. Forwarded with the lease id, because the
 * session for this lease usually does not exist yet, so the sink buffers.
 */
export async function listenForPageErrors(
  page: PooledPage,
  leaseId: string,
  hooks: LeasePageErrorHooks | undefined,
): Promise<void> {
  page.onPageError?.((error) => {
    hooks?.onPageError?.(leaseId, error);
  });
  await page.addInitScript?.(queueEarlyConsole, EARLY_CAPTURE_ARG);
}

/**
 * Report a closed lease — manual release, reaper and crash reclaim all funnel through the pool's
 * one release path. The wiring owns whether anything was kept FOR that lease and drops it.
 */
export function reportLeaseClosed(hooks: LeasePageErrorHooks | undefined, leaseId: string): void {
  hooks?.onLeaseClosed?.(leaseId);
}

/** How many console calls and error events a page keeps for an SDK that has not installed yet. */
export const EARLY_CAPTURE_LIMIT = 200;

/**
 * The argument for `queueEarlyConsole`. Every driven page gets the same one: a pool lease, and
 * `verify`'s own page. It looks for the SDK every `pollMs`, for at most `maxPolls` looks (30 s).
 */
export const EARLY_CAPTURE_ARG = {
  key: RETICLE_EARLY_CAPTURE,
  limit: EARLY_CAPTURE_LIMIT,
  pollMs: 50,
  maxPolls: 600,
};

interface EarlyCaptureArg {
  key: string;
  limit: number;
  pollMs: number;
  maxPolls: number;
}

type ConsoleFn = (...args: unknown[]) => void;

type EventCtor = new (type: string, init: Record<string, unknown>) => unknown;

interface W {
  console: Record<'error' | 'warn', ConsoleFn>;
  addEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
  dispatchEvent(event: unknown): boolean;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  ErrorEvent: EventCtor;
  PromiseRejectionEvent: EventCtor;
  [key: string]: unknown;
}

/**
 * Init script: keep the console errors and warnings a page logs before the SDK installs.
 *
 * An app connects the SDK from a module script or a bundle, and both run after the page's own
 * classic scripts. An error such a script logs while the page loads was lost, so "no console
 * errors" passed on a page that logged one on every load. Playwright's own console event is not a
 * substitute: it also reports messages the browser writes itself (a failed WebSocket, which is how
 * the SDK's own first dial can fail), and the SDK's console channel has never counted those.
 *
 * So this keeps the RAW calls and events. Once the SDK has wrapped the console, this hands them to
 * it: each call goes through the console again and each event is dispatched again, so the SDK's own
 * handlers report them and the meaning of "console error" stays the SDK's. The SDK needs no code for
 * this, so a page that Reticle does not drive downloads nothing for it. Entries the bound did not
 * keep are declared with one console warning. Must stay self-contained: Playwright serialises the
 * function source into the page.
 */
export function queueEarlyConsole(arg: EarlyCaptureArg): void {
  const win = (globalThis as unknown as { window?: W }).window;
  if (win === undefined || win[arg.key] !== undefined) {
    return;
  }
  const capture = { queue: [] as unknown[], dropped: 0 };
  win[arg.key] = capture;
  const keep = (item: unknown): void => {
    if (win[arg.key] !== capture) {
      return;
    }
    if (capture.queue.length < arg.limit) {
      capture.queue.push(item);
    } else {
      capture.dropped += 1;
    }
  };
  const mine: Partial<Record<'error' | 'warn', ConsoleFn>> = {};
  for (const method of ['error', 'warn'] as const) {
    const original = win.console[method];
    const wrapper = (...args: unknown[]): void => {
      keep({ method, args });
      original.apply(win.console, args);
    };
    mine[method] = wrapper;
    win.console[method] = wrapper;
  }
  win.addEventListener('error', (event) => keep({ event }), true);
  win.addEventListener('unhandledrejection', (event) => keep({ event }), true);

  // A copy of a kept event: an event that has been dispatched once is copied, not sent again.
  const copy = (event: Record<string, unknown>): unknown => {
    if ('reason' in event) {
      return new win.PromiseRejectionEvent('unhandledrejection', {
        promise: event['promise'],
        reason: event['reason'],
      });
    }
    const init: Record<string, unknown> = {};
    for (const field of ['message', 'filename', 'lineno', 'colno', 'error']) {
      if (event[field] !== undefined) {
        init[field] = event[field];
      }
    }
    return new win.ErrorEvent('error', init);
  };
  let polls = 0;
  const timer = win.setInterval(() => {
    polls += 1;
    // The SDK has installed when the console is no longer this script's own wrapper.
    const installed = win.console.error !== mine.error;
    if (!installed && polls < arg.maxPolls) {
      return;
    }
    win.clearInterval(timer);
    win[arg.key] = null;
    if (!installed) {
      return;
    }
    for (const item of capture.queue as Record<string, unknown>[]) {
      if ('method' in item) {
        win.console[item['method'] as 'error' | 'warn'](...(item['args'] as unknown[]));
      } else {
        win.dispatchEvent(copy(item['event'] as Record<string, unknown>));
      }
    }
    if (capture.dropped > 0) {
      win.console.warn(`reticle: ${String(capture.dropped)} early console entries were not kept`);
    }
  }, arg.pollMs);
}

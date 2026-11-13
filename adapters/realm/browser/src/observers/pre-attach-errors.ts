/**
 * Read the errors a page raised before the SDK attached (#1540).
 *
 * The console observer installs in `connect()`, and on a Vite app the connect module runs after the
 * app's entry module. An entry module that 404s, is served as HTML or throws on import raised its
 * error while nothing was listening, so `reticle_look` showed an empty page and the console channel
 * showed nothing: a blank page could not be told apart from an app that crashed on load.
 *
 * The build plugin injects an inline buffer ahead of the app's scripts (PRE_ATTACH_ERRORS_SOURCE in
 * `@reticlehq/vite-plugin`). It keeps raw `error` events, unhandled rejections and `console.error`
 * arguments in RETICLE_PRE_ATTACH_ERRORS. This takes them ONCE and closes the buffer, so an error is
 * never kept after the SDK listens itself, and a second connect on the same page reports nothing
 * again.
 *
 * The buffer is page data, so its shape is checked here, not trusted: a value that is not the shape
 * the plugin writes gives nothing.
 */
import { RETICLE_PRE_ATTACH_ERRORS } from '@reticlehq/core';
import { observeValue } from './types.js';

/** One kept entry: an event the page dispatched, or the arguments of one `console.error` call. */
export type PreAttachEntry =
  | { readonly kind: 'event'; readonly event: Event }
  | { readonly kind: 'console'; readonly args: readonly unknown[] };

export interface PreAttachErrors {
  readonly entries: readonly PreAttachEntry[];
  /** How many entries the buffer did not keep, because it was full. */
  readonly dropped: number;
}

interface RawBuffer {
  open?: unknown;
  queue?: unknown;
  dropped?: unknown;
  close?: unknown;
}

function toEntry(item: unknown): PreAttachEntry | undefined {
  if ('object' !== typeof item || null === item) {
    return undefined;
  }
  const record = item as { event?: unknown; args?: unknown };
  if (record.event instanceof Event) {
    return { kind: 'event', event: record.event };
  }
  if (Array.isArray(record.args)) {
    return { kind: 'console', args: record.args as unknown[] };
  }
  return undefined;
}

/** Take what the pre-attach buffer kept, and close it. `undefined` when there is no open buffer. */
export function takePreAttachErrors(): PreAttachErrors | undefined {
  const holder = globalThis as unknown as Record<string, unknown>;
  const raw = observeValue(() => holder[RETICLE_PRE_ATTACH_ERRORS]);
  if ('object' !== typeof raw || null === raw) {
    return undefined;
  }
  const buffer = raw as RawBuffer;
  if (true !== buffer.open) {
    return undefined;
  }
  const queue = Array.isArray(buffer.queue) ? (buffer.queue as unknown[]).slice() : [];
  const dropped = 'number' === typeof buffer.dropped ? buffer.dropped : 0;
  // Closed before the caller reports anything: from here the SDK's own listeners hear every error,
  // so a buffer that kept listening would hold a second copy of each one.
  if ('function' === typeof buffer.close) {
    observeValue(() => (buffer.close as () => void)());
  }
  buffer.open = false;
  const entries: PreAttachEntry[] = [];
  for (const item of queue) {
    const entry = toEntry(item);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return { entries, dropped };
}

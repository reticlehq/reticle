/** Read response clones without making the app wait for body capture. */
import { ResponseBodyReason } from '@reticlehq/core/page';
import { nativeClearTimeout, nativeSetTimeout } from '@/timers/native/native-timers.js';
import {
  networkBodyMaxChars,
  projectBody,
  projectErrorBody,
  withBodyDeadline,
} from './network-body.js';
import { isEventStream } from './network-event-stream.js';
export { isEventStream };

const EVENT_STREAM_READ_MS = 10_000;
const UTF8_MAX_BYTES_PER_CHAR = 4;
const REDACTION_LOOKAHEAD = 2;

/** Keep a bounded prefix. Cancel only our branch, without waiting for the app's branch. */
async function readEventStream(
  clone: Response,
  signal: AbortSignal,
): Promise<{ text: string; complete: boolean } | undefined> {
  if (signal.aborted || typeof clone.body?.getReader !== 'function') {
    return undefined;
  }
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  const limit = networkBodyMaxChars() * REDACTION_LOOKAHEAD;
  let text = '';
  let complete = false;
  let stopped = false;
  let stop = (): void => undefined;
  const interrupted = new Promise<void>((resolve) => {
    stop = () => {
      // Pending reads can resume before the race continuation runs its cleanup.
      stopped = true;
      resolve();
    };
  });
  const timer = nativeSetTimeout(stop, EVENT_STREAM_READ_MS);
  signal.addEventListener('abort', stop, { once: true });
  try {
    // Race the whole drain, not each read. Repeated races would retain one deadline listener per chunk.
    await Promise.race([
      (async () => {
        while (!stopped && !signal.aborted) {
          const next = await reader.read();
          if (stopped || signal.aborted) {
            return;
          }
          if (next.done) {
            text += decoder.decode();
            complete = true;
            return;
          }
          const remaining = limit - text.length;
          const bytes = next.value.subarray(0, remaining * UTF8_MAX_BYTES_PER_CHAR);
          const decoded = decoder.decode(bytes, { stream: true });
          text += decoded.slice(0, remaining);
          if (text.length >= limit || bytes.byteLength < next.value.byteLength) {
            return;
          }
        }
      })(),
      interrupted,
    ]);
  } catch {
    // A read error leaves an incomplete prefix, not a complete response.
  } finally {
    nativeClearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return !complete && 0 === text.length ? undefined : { text, complete };
}

/** Return existing wire fields, including loss and unavailable-body markers. */
export async function captureResponseBody(
  response: Response,
  contentType: string | null,
  captureBodies: boolean,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const unreadable = captureBodies ? { responseBodyReason: ResponseBodyReason.UNREADABLE } : {};
  if (isEventStream(contentType) && (!captureBodies || signal.aborted)) {
    return unreadable;
  }
  try {
    const clone = response.clone();
    let text: string | undefined;
    let incomplete = false;
    if (isEventStream(contentType)) {
      const stream = await readEventStream(clone, signal);
      text = stream?.text;
      incomplete = false === stream?.complete;
    } else {
      text = await withBodyDeadline(clone.text());
    }
    if (undefined === text) {
      return unreadable;
    }
    const projected = captureBodies
      ? projectBody(text, contentType)
      : projectErrorBody(text, contentType);
    return {
      responseBody: projected.body,
      ...(incomplete || projected.truncated ? { responseBodyTruncated: true } : {}),
      ...(captureBodies ? {} : { responseBodyReason: ResponseBodyReason.ERROR_STATUS }),
    };
  } catch {
    return unreadable;
  }
}

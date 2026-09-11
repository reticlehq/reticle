/**
 * Watching a STREAMED response body to its end, so `settled` cannot pass mid-stream.
 *
 * Split out of network.ts, which was already at its line cap. One question: when did this response
 * actually finish arriving?
 */
import { EventType, StreamDirection, StreamTransport } from '@reticlehq/core';
import type { Emit } from './types.js';
import { isStreamingBody } from './network-body.js';
import { nativeClearTimeout, nativeSetTimeout } from '../timers/native-timers.js';

/**
 * Longest a streamed response body is watched before the record is closed anyway.
 *
 * An endless stream must never hold `settled` open forever. Ten seconds is longer than any
 * page-render stream and short enough that a genuinely endless one costs one settle window, not the
 * session.
 */
const STREAM_WATCH_MS = 10_000;

/**
 * Watch a STREAMED response body to its end, so `settled` cannot pass while the server is still
 * writing.
 *
 * `fetch` resolves at HEADERS. On a Next.js App Router page the RSC payload's NET_REQUEST landed
 * 16 ms in, the shell rendered at 3013, and the Suspense boundary's rows arrived at 3902 — 889 ms
 * in which NOTHING was observed. Quiet is exactly what settle tests for, so it passed with the
 * fallback still on screen and zero rows rendered: a green on every streaming boundary.
 *
 * STRUCTURAL, not an allowlist: a response with a body and no `content-length` is being sent
 * chunked, which is the wire's own way of saying the server is still writing. An earlier version
 * gated on a content-type list containing `x-component` — "Next.js RSC, plus two guesses" — which
 * closed the one defect it was written against and left every other streamed response as invisible
 * as before. The clone is DRAINED as it arrives rather than buffered, so watching costs a second
 * read of bytes already in flight, not a second copy held in memory.
 *
 * BOUNDED both ways: an endless stream (SSE over fetch, a live feed) must not hold `settled` open
 * forever, so the watch gives up after STREAM_WATCH_MS and closes the record anyway, marked
 * `gaveUp`. That is the safe direction — a settle that eventually proceeds beats one that never
 * does — and it says which happened rather than pretending the stream ended.
 */
export function watchStreamedBody(
  emit: Emit,
  res: Response,
  id: string,
  url: string,
  contentType: string | null,
  contentLength: string | null,
): void {
  // `=== null` is not enough: jsdom's Response has no `body` at all, and older/polyfilled
  // implementations return undefined. Reaching for `.getReader()` on that threw an unhandled
  // rejection out of a detached promise — an observability layer throwing into the host page, from
  // code the host never called. Duck-type the reader instead of trusting the shape.
  if (!isStreamingBody(contentType, contentLength)) return;
  if (typeof res.body?.getReader !== 'function') return;
  let clone: Response | undefined;
  try {
    clone = res.clone();
  } catch {
    return; // already consumed or locked — the app owns it; observing it would take it away
  }
  const body = clone.body;
  if (null === body) return;
  emit(EventType.NET_STREAM, {
    transport: StreamTransport.FETCH,
    direction: StreamDirection.OPEN,
    url,
    id,
  });
  void (async () => {
    const reader = body.getReader();
    let gaveUp = false;
    // The deadline must be a TIMER, not a check after each read. An idle stream parks inside
    // `read()` waiting for a chunk that may never come, so a post-read check never runs and the
    // record never closes — which would hold `settled` open forever on exactly the endless streams
    // the bound exists to protect against.
    let timer: number | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = nativeSetTimeout(() => resolve('expired'), STREAM_WATCH_MS);
    });
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), expired]);
        if ('expired' === next) {
          gaveUp = true;
          void reader.cancel().catch(() => undefined);
          break;
        }
        if (next.done) break;
      }
    } catch {
      /* aborted or errored — the stream is over either way, which is what we report */
    } finally {
      if (timer !== undefined) nativeClearTimeout(timer);
    }
    emit(EventType.NET_STREAM, {
      transport: StreamTransport.FETCH,
      direction: StreamDirection.CLOSE,
      url,
      id,
      ...(gaveUp ? { gaveUp: true } : {}),
    });
  })();
}

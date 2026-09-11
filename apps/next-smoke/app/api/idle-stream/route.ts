/**
 * An ndjson stream that flushes ONE chunk and then says nothing, forever.
 *
 * This is the shape that would hang a naive stream watcher: headers arrive, so `fetch` resolves and
 * the request is recorded complete; the reader then parks inside `read()` waiting for a chunk that
 * never comes, so any deadline checked AFTER a read never runs and the body is never reported
 * closed. `settled` must still pass eventually — the bound is a timer, and giving up is reported
 * rather than mistaken for the stream having ended.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': open\n\n')); // flush headers, then idle forever
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
  });
}

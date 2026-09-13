import { describe, it, expect, vi, afterEach } from 'vitest';
import { installNetwork } from './network.js';
import type { Emit, Teardown } from './types.js';

/**
 * Body capture must never make the app's own `fetch` wait.
 *
 * The observer reads a CLONE of the response so the app's stream stays untouched — but it awaited that
 * clone BEFORE returning the response. A clone of a stream only settles when the stream ends, and an
 * SSE stream does not end, so `await fetch('/api/chat')` never resolved. `text/event-stream` matches
 * `text/` in CAPTURABLE_CONTENT, so simply enabling body capture hung every streaming endpoint: a
 * permanently loading UI, and no reason for the developer to suspect the observability SDK.
 *
 * These tests assert the host app's control flow, not the emitted event — the app resolving is the
 * property that matters.
 */

const teardowns: Teardown[] = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) t();
  vi.unstubAllGlobals();
});

function collect(): { emit: Emit; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return { emit: (type, data) => events.push({ type, data }), events };
}

/** NET_REQUEST (with the body) is emitted from a detached promise so the app never waits; let it land. */
const flushBody = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A response whose body never completes — an SSE endpoint held open by the server. */
function neverEndingResponse(contentType: string): Response {
  const res = {
    headers: { get: (k: string) => ('content-type' === k.toLowerCase() ? contentType : null) },
    status: 200,
    ok: true,
    clone: () => ({ text: () => new Promise<string>(() => undefined) }),
  };
  return res as unknown as Response;
}

describe('body capture must not block the host app', () => {
  it('returns an SSE response to the app instead of waiting for the stream to end', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(neverEndingResponse('text/event-stream')));
    const { emit } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));

    // If the observer awaits the clone, this never settles and the test times out — which is exactly
    // what the host app experiences.
    const res = await Promise.race([
      window.fetch('/api/chat'),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1000)),
    ]);
    expect(res).not.toBe('HUNG');
  });

  it('returns a chunked JSON response promptly too (token-streaming model APIs)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(neverEndingResponse('application/json')));
    const { emit } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    const res = await Promise.race([
      window.fetch('/api/completions'),
      // Bounded, not unbounded: a content-type-less stream costs the app the body deadline once,
      // never the lifetime of the stream.
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1500)),
    ]);
    expect(res).not.toBe('HUNG');
  });

  it('still captures a normal, complete JSON body', async () => {
    const body = JSON.stringify({ ok: true });
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        headers: { get: () => 'application/json' },
        status: 200,
        ok: true,
        clone: () => ({ text: () => Promise.resolve(body) }),
      } as unknown as Response),
    );
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    await window.fetch('/api/thing');
    await flushBody();
    const withBody = events.find((e) => e.data['responseBody'] !== undefined);
    expect(String(withBody?.data['responseBody'])).toContain('ok');
  });
});

/**
 * Work must not scale with body size.
 *
 * The 500ms deadline bounds how long the SDK WAITS for a body, but everything after it was synchronous
 * and unbounded: JSON.parse over the whole text, a deep sanitising walk, a re-stringify, then two global
 * regexes — with the 8 KB cap applied last. A 30 MB CSV export or a large HTML error page resolves fast,
 * so the deadline never fires, and the app freezes on the main thread instead. That is the same class of
 * host-app damage as the hang, with the SDK still the cause.
 */
describe('body projection is bounded by input size, not just output size', () => {
  const hugeBody = (chars: number, contentType: string): void => {
    const body = 'x'.repeat(chars);
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        headers: { get: () => contentType },
        status: 200,
        ok: true,
        clone: () => ({ text: () => Promise.resolve(body) }),
      } as unknown as Response),
    );
  };

  /**
   * Bounded by INPUT size, proven without a wall-clock assertion.
   *
   * This used to assert `Date.now() - started < 1000`, which is a statement about the machine, not
   * about the code. It passed alone and failed reproducibly when the rest of the suite ran in
   * parallel under load — and it cost a commit through a red gate before it was identified. Its own
   * comment already said the point was that "cost is FIXED, not that it is fast here", so the
   * assertion contradicted the thing it was written to check.
   *
   * The regression it guards is UNBOUNDED work: without the input cap, 4 MB gets parsed and
   * regex-swept in full, which does not merely get slow, it exceeds any sane budget by orders of
   * magnitude (the same pass costs ~2s at 64 KB — this input is 60x that). A generous per-test
   * timeout catches exactly that and is immune to how loaded the machine is; the output-size
   * assertion below carries the rest.
   */
  it('projects a very large text body without scanning all of it', async () => {
    hugeBody(4_000_000, 'text/csv');
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    await window.fetch('/api/export.csv');
    await flushBody();
    const withBody = events.find((e) => e.data['responseBody'] !== undefined);
    expect(String(withBody?.data['responseBody']).length).toBeLessThanOrEqual(8192);
    expect(withBody?.data['responseBodyTruncated']).toBe(true);
  }, 10_000);

  it('marks an over-large body as truncated — never reports a clipped read as complete', async () => {
    hugeBody(4_000_000, 'text/plain');
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    await window.fetch('/api/big.txt');
    await flushBody();
    const withBody = events.find((e) => e.data['responseBody'] !== undefined);
    expect(withBody?.data['responseBodyTruncated']).toBe(true);
  });
});

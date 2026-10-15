import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventType, ResponseBodyReason } from '@reticlehq/core';
import { installNetwork } from './network.js';
import type { Emit, Teardown } from './types.js';

/**
 * #1520: with body capture ON, a body the SDK skips on purpose says why.
 *
 * A streamed response (`text/event-stream`) is never read, because reading it would hang the app,
 * and a binary type is not recorded. Both reached the engine as a call with no `responseBody` and no
 * reason, which is exactly what a call looks like with capture OFF. A body clause then answered `no`
 * and told the caller to enable a setting that was already on. With capture off nothing is stamped,
 * so that case keeps its own remedy.
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

/** NET_REQUEST is emitted from a detached promise when a body is read; let it land. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function response(contentType: string | null, text: () => Promise<string>): Response {
  return {
    headers: {
      get: (k: string) => ('content-type' === k.toLowerCase() ? contentType : null),
    },
    status: 200,
    ok: true,
    clone: () => ({ text }),
  } as unknown as Response;
}

async function requestFor(res: Response, captureBodies: boolean): Promise<Record<string, unknown>> {
  vi.stubGlobal('fetch', () => Promise.resolve(res));
  const { emit, events } = collect();
  teardowns.push(installNetwork(emit, { captureBodies }));
  await fetch('/mcp', { method: 'POST' });
  await flush();
  const request = events.find((e) => e.type === EventType.NET_REQUEST);
  expect(request).toBeDefined();
  return request?.data ?? {};
}

describe('a body skipped with capture on carries its reason', () => {
  it('a streamed response is marked streaming', async () => {
    const data = await requestFor(
      response('text/event-stream', () => Promise.resolve('data: x')),
      true,
    );
    expect(data['responseBody']).toBeUndefined();
    expect(data['responseBodyReason']).toBe(ResponseBodyReason.STREAMING);
  });

  it('an ndjson stream is marked streaming', async () => {
    const data = await requestFor(
      response('application/x-ndjson', () => Promise.resolve('{}')),
      true,
    );
    expect(data['responseBodyReason']).toBe(ResponseBodyReason.STREAMING);
  });

  it('a binary body is marked not-text', async () => {
    const data = await requestFor(
      response('image/png', () => Promise.resolve('')),
      true,
    );
    expect(data['responseBodyReason']).toBe(ResponseBodyReason.NOT_TEXT);
  });

  it('a text body whose read fails is marked unreadable', async () => {
    const data = await requestFor(
      response('application/json', () => Promise.reject(new Error('locked'))),
      true,
    );
    expect(data['responseBody']).toBeUndefined();
    expect(data['responseBodyReason']).toBe(ResponseBodyReason.UNREADABLE);
  });

  it('a body with no content type at all (a 204) carries no reason', async () => {
    const data = await requestFor(
      response(null, () => Promise.resolve('')),
      true,
    );
    expect(data['responseBodyReason']).toBeUndefined();
  });
});

describe('what is unchanged', () => {
  it('a recorded body carries the body and no reason', async () => {
    const data = await requestFor(
      response('application/json', () => Promise.resolve('{"ok":true}')),
      true,
    );
    expect(data['responseBody']).toBe('{"ok":true}');
    expect(data['responseBodyReason']).toBeUndefined();
  });

  it('with capture off, a skipped stream is not stamped: no reason means capture was off', async () => {
    const data = await requestFor(
      response('text/event-stream', () => Promise.resolve('data: x')),
      false,
    );
    expect(data['responseBodyReason']).toBeUndefined();
  });
});

/** An XHR double: answers with the given content type and responseType on `send`. */
function fakeXhr(contentType: string, responseType: string, responseText = 'data: x'): void {
  class FakeXhr {
    responseType = responseType;
    status = 200;
    statusText = 'OK';
    readonly #listeners: Array<() => void> = [];
    get responseText(): string {
      if ('' !== this.responseType && 'text' !== this.responseType) {
        throw new Error('responseText is only readable for text responses');
      }
      return responseText;
    }
    open(): void {
      /* recorded by the patch */
    }
    send(): void {
      for (const listener of this.#listeners) listener();
    }
    getResponseHeader(name: string): string | null {
      return 'content-type' === name.toLowerCase() ? contentType : null;
    }
    addEventListener(type: string, listener: () => void): void {
      if ('loadend' === type) this.#listeners.push(listener);
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}

function xhrRequestFor(captureBodies: boolean): Record<string, unknown> {
  const { emit, events } = collect();
  teardowns.push(installNetwork(emit, { captureBodies }));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/mcp');
  xhr.send('{}');
  const request = events.find((e) => e.type === EventType.NET_REQUEST);
  expect(request).toBeDefined();
  return request?.data ?? {};
}

describe('the XHR path stamps the same reasons (#1630 review)', () => {
  it('an SSE response is marked streaming', () => {
    fakeXhr('text/event-stream', '');
    const data = xhrRequestFor(true);
    expect(data['responseBody']).toBeUndefined();
    expect(data['responseBodyReason']).toBe(ResponseBodyReason.STREAMING);
  });

  it('a binary response is marked not-text', () => {
    fakeXhr('application/octet-stream', 'arraybuffer');
    expect(xhrRequestFor(true)['responseBodyReason']).toBe(ResponseBodyReason.NOT_TEXT);
  });

  it('a JSON response read as responseType json is marked unreadable', () => {
    fakeXhr('application/json', 'json', '{"ok":true}');
    const data = xhrRequestFor(true);
    expect(data['responseBody']).toBeUndefined();
    expect(data['responseBodyReason']).toBe(ResponseBodyReason.UNREADABLE);
  });

  it('a readable text response carries its body and no reason', () => {
    fakeXhr('application/json', '', '{"ok":true}');
    const data = xhrRequestFor(true);
    expect(data['responseBody']).toBe('{"ok":true}');
    expect(data['responseBodyReason']).toBeUndefined();
  });

  it('with capture off, nothing is stamped', () => {
    fakeXhr('text/event-stream', '');
    expect(xhrRequestFor(false)['responseBodyReason']).toBeUndefined();
  });
});

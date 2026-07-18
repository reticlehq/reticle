import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installNetwork, redactUrl } from './network.js';
import type { Emit, Teardown } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

/** A minimal Response stand-in — jsdom does not always expose a usable global Response. */
function fakeResponse(
  status: number,
  opts: { statusText?: string; headers?: Record<string, string> } = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: opts.statusText ?? '',
    headers: new Headers(opts.headers ?? {}),
  } as Response;
}

describe('redactUrl', () => {
  it('redacts credential-bearing query params, keeps the rest', () => {
    expect(redactUrl('http://api/x?access_token=secret&page=2')).toBe(
      'http://api/x?access_token=%5BREDACTED%5D&page=2',
    );
    expect(redactUrl('/magic?api_key=abc')).toBe('/magic?api_key=%5BREDACTED%5D');
  });

  it('leaves URLs with no sensitive params byte-for-byte unchanged', () => {
    expect(redactUrl('http://api/x?page=2&sort=asc')).toBe('http://api/x?page=2&sort=asc');
    expect(redactUrl('http://api/x')).toBe('http://api/x');
  });

  it('preserves a trailing #hash', () => {
    expect(redactUrl('/p?token=t#section')).toBe('/p?token=%5BREDACTED%5D#section');
  });

  it('redacts a path-embedded token after a sensitive segment name', () => {
    expect(redactUrl('https://app.com/reset/AbC123deadbeef99')).toBe(
      'https://app.com/reset/[REDACTED]',
    );
    expect(redactUrl('/invite/aBcD1234EfGh5678?ref=x')).toBe('/invite/[REDACTED]?ref=x');
  });

  it('leaves short non-token segments after a sensitive name alone', () => {
    expect(redactUrl('/reset/form')).toBe('/reset/form');
    expect(redactUrl('/password/reset')).toBe('/password/reset');
  });
  it('redacts credentials embedded in the URL authority (user:pass@host)', () => {
    expect(redactUrl('https://alice:s3cr3t@api.example.com/data')).toBe(
      'https://[REDACTED]@api.example.com/data',
    );
    expect(redactUrl('http://plainhost.com/x')).toBe('http://plainhost.com/x');
  });
  it('redacts a token in the URL FRAGMENT (OAuth implicit flow) but leaves plain anchors alone', () => {
    expect(redactUrl('https://app.com/cb#access_token=ya29SECRETVAL&token_type=bearer')).toContain(
      'access_token=[REDACTED]',
    );
    expect(redactUrl('https://app.com/cb#access_token=ya29SECRETVAL')).not.toContain(
      'ya29SECRETVAL',
    );
    expect(redactUrl('https://app.com/page#section-two')).toBe('https://app.com/page#section-two');
  });
});

describe('installNetwork (fetch)', () => {
  let teardown: Teardown | undefined;
  const origFetch = window.fetch;

  beforeEach(() => {
    // Ensure there is a fetch for the observer to wrap; each test overrides the behavior.
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(200)));
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    window.fetch = origFetch;
  });

  function fakeResponseWithBody(status: number, contentType: string, bodyText: string): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      clone: () => ({ text: () => Promise.resolve(bodyText) }),
    } as unknown as Response;
  }

  it('captures + redacts request and response bodies only when opted in (Network 1b)', async () => {
    // Fake credential values held in variables so the object literals do not read as hardcoded
    // secrets to the repo's secret scanner — the point is that the observer redacts them.
    const respTokenValue = 'resp-token-abcdef123';
    const reqPasswordValue = 'req-pass-abcdef123';
    const respBody = JSON.stringify({ items: [{ id: 1 }], token: respTokenValue });
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', respBody)),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/api/data', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com', password: reqPasswordValue }),
    });
    const data = events[1]?.data as Record<string, unknown>;
    expect(String(data['responseBody'])).toContain('"id":1');
    expect(String(data['responseBody'])).toContain('[REDACTED]'); // token value redacted
    expect(String(data['responseBody'])).not.toContain(respTokenValue);
    expect(String(data['requestBody'])).toContain('[REDACTED]'); // password value redacted
    expect(String(data['requestBody'])).not.toContain(reqPasswordValue);
  });

  it('redacts sensitive key=value pairs in a NON-JSON (form-urlencoded) body', async () => {
    const formPasswordValue = 'form-pass-abcdef123';
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"ok":true}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/login', {
      method: 'POST',
      body: `username=alice&password=${formPasswordValue}`,
    });
    const data = events[1]?.data as Record<string, unknown>;
    expect(String(data['requestBody'])).toContain('username=alice'); // non-sensitive kept
    expect(String(data['requestBody'])).toContain('password=[REDACTED]');
    expect(String(data['requestBody'])).not.toContain(formPasswordValue);
  });

  it('does NOT over-redact prose containing the words Bearer/Basic (no false positive)', async () => {
    const prose =
      'Basic subscription includes support. Bearer capacity exceeded the threshold today.';
    window.fetch = vi.fn(() => Promise.resolve(fakeResponseWithBody(200, 'text/plain', prose)));
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/docs');
    expect(String((events[1]?.data as Record<string, unknown>)['responseBody'])).toBe(prose);
  });

  it('scrubs a high-confidence secret sitting in a JSON VALUE under a benign key', async () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.sig123ABCdef';
    const body = JSON.stringify({ note: `token is ${jwt}` });
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', body)),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/api/x');
    const rb = String((events[1]?.data as Record<string, unknown>)['responseBody']);
    expect(rb).toContain('[REDACTED]');
    expect(rb).not.toContain(jwt);
  });

  it('captures + redacts a URLSearchParams request body (not just strings)', async () => {
    const pw = 'usp-pass-abcdef123';
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"ok":1}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/login', {
      method: 'POST',
      body: new URLSearchParams({ user: 'bob', password: pw }),
    });
    const rb = String((events[1]?.data as Record<string, unknown>)['requestBody']);
    expect(rb).toContain('password=[REDACTED]');
    expect(rb).not.toContain(pw);
  });

  it('marks a non-text request body (FormData) with a type instead of dropping it', async () => {
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"ok":1}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    const fd = new FormData();
    fd.append('field', 'value');
    await window.fetch('http://localhost:8787/upload', { method: 'POST', body: fd });
    expect((events[1]?.data as Record<string, unknown>)['requestBodyType']).toBe('FormData');
  });

  it('does NOT capture bodies by default (opt-in only)', async () => {
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"x":1}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    await window.fetch('http://localhost:8787/api/x');
    expect((events[1]?.data as Record<string, unknown>)['responseBody']).toBeUndefined();
  });

  it('captures content-type, response size, and status text without reading the body (Network 1a)', async () => {
    window.fetch = vi.fn(() =>
      Promise.resolve(
        fakeResponse(200, {
          statusText: 'OK',
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '1234' },
        }),
      ),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    await window.fetch('http://localhost:8787/api/data');
    expect(events[1]?.data).toMatchObject({
      contentType: 'application/json; charset=utf-8',
      responseSize: 1234,
      statusText: 'OK',
    });
  });

  it('emits NET_PENDING at start then NET_REQUEST for a GET that resolves with a 500', async () => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(500)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    const res = await window.fetch('http://localhost:8787/api/broken/500');

    expect(res.status).toBe(500);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe(EventType.NET_PENDING);
    expect(events[0]?.data).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/500',
      initiator: 'fetch',
    });
    expect(events[1]?.type).toBe(EventType.NET_REQUEST);
    expect(events[1]?.data).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/500',
      status: 500,
      ok: false,
      initiator: 'fetch',
    });
    // The pending and the completion share a correlation id.
    expect(events[1]?.data['id']).toBe(events[0]?.data['id']);
  });

  it('captures the method from init for a POST (completion is the second event)', async () => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(200)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    await window.fetch('http://localhost:8787/api/login', { method: 'POST' });

    expect(events[0]?.type).toBe(EventType.NET_PENDING);
    expect(events[1]?.data).toMatchObject({ method: 'POST', status: 200, ok: true });
  });

  it('emits a NET_REQUEST with status 0 and rethrows when the fetch rejects', async () => {
    const boom = new Error('network down');
    window.fetch = vi.fn(() => Promise.reject(boom));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    await expect(window.fetch('http://localhost:8787/api/x')).rejects.toBe(boom);
    expect(events).toHaveLength(2);
    expect(events[1]?.data).toMatchObject({ status: 0, ok: false, error: 'network down' });
  });

  it('emits only NET_PENDING for a request that never resolves (the hung-request case)', () => {
    // A fetch whose promise never settles — the regression no completion-only logging can see.
    window.fetch = vi.fn(() => new Promise<Response>(() => {}));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    void window.fetch('http://localhost:8787/api/broken/timeout');

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.NET_PENDING);
    expect(events[0]?.data).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/timeout',
      initiator: 'fetch',
    });
  });

  it('restores the original fetch on teardown', () => {
    const before = window.fetch;
    const t = installNetwork(collect().emit);
    expect(window.fetch).not.toBe(before);
    t();
    expect(window.fetch).toBe(before);
  });
});

/** Controllable WebSocket double (jsdom has none) that the observer subclass can extend + drive. */
class FakeWebSocket {
  static readonly OPEN = 1;
  #listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly url: string;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }
  send(_data: unknown): void {
    /* no-op transport */
  }
  dispatch(type: string, ev: unknown): void {
    (this.#listeners[type] ?? []).forEach((cb) => cb(ev));
  }
}

describe('installNetwork (WebSocket / SSE frames, Network 1f)', () => {
  const origWS = window.WebSocket;
  afterEach(() => {
    window.WebSocket = origWS;
  });

  it('captures open, outbound send, and inbound message frames when opted in', () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });

    const ws = new window.WebSocket('ws://localhost:8787/live') as unknown as FakeWebSocket;
    ws.send('{"hello":1}');
    ws.dispatch('message', { data: '{"price":42}' });
    teardown();

    const streams = events.filter((e) => e.type === EventType.NET_STREAM);
    expect(streams.map((s) => s.data['direction'])).toEqual(['open', 'out', 'in']);
    expect(String(streams[2]?.data['frame'])).toContain('"price":42');
    expect(window.WebSocket).toBe(FakeWebSocket); // teardown restored the (test's) original
  });

  it('does NOT patch streaming transports when body capture is off', () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit } = collect();
    const teardown = installNetwork(emit); // no captureBodies
    expect(window.WebSocket).toBe(FakeWebSocket); // untouched
    teardown();
  });
});

/** A minimal XMLHttpRequest stand-in — jsdom's real XHR would attempt a live network request. */
class FakeXHR {
  #listeners: Record<string, ((ev: unknown) => void)[]> = {};
  status = 0;
  statusText = '';
  responseText = '';
  responseType = '';
  #headers: Record<string, string> = {};
  method = '';
  url = '';
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  send(_body?: unknown): void {
    /* no-op transport */
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }
  getResponseHeader(k: string): string | null {
    return this.#headers[k.toLowerCase()] ?? null;
  }
  complete(opts: { status?: number; contentType?: string; responseText?: string } = {}): void {
    this.status = opts.status ?? 200;
    this.statusText = 'OK';
    if (opts.contentType !== undefined) this.#headers['content-type'] = opts.contentType;
    this.responseText = opts.responseText ?? '';
    (this.#listeners['loadend'] ?? []).forEach((cb) => cb({}));
  }
}

describe('installNetwork (XMLHttpRequest)', () => {
  const origXHR = window.XMLHttpRequest;
  afterEach(() => {
    window.XMLHttpRequest = origXHR;
  });

  it('captures an XHR completion with status, redacted url, and initiator', () => {
    window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    const { emit, events } = collect();
    const teardown = installNetwork(emit);
    const xhr = new window.XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/api/data?access_token=SECRETXHR&page=1');
    xhr.send();
    xhr.complete({ status: 200 });
    teardown();

    const done = events.find((e) => e.type === EventType.NET_REQUEST);
    expect(done?.data['status']).toBe(200);
    expect(done?.data['initiator']).toBe('xhr');
    expect(String(done?.data['url'])).toContain('access_token=%5BREDACTED%5D');
    expect(String(done?.data['url'])).not.toContain('SECRETXHR');
  });

  it('a REUSED XHR emits exactly one completion per send (no accumulated listeners)', () => {
    window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    const { emit, events } = collect();
    const teardown = installNetwork(emit);
    const xhr = new window.XMLHttpRequest() as unknown as FakeXHR;

    xhr.open('GET', '/first');
    xhr.send();
    xhr.complete({ status: 200 });
    xhr.open('GET', '/second');
    xhr.send();
    xhr.complete({ status: 201 });
    teardown();

    const done = events.filter((e) => e.type === EventType.NET_REQUEST);
    expect(done.length).toBe(2); // NOT 3 — the first send's listener must not re-fire on the second
    expect(done.map((e) => e.data['url'])).toEqual(['/first', '/second']);
    expect(done.map((e) => e.data['status'])).toEqual([200, 201]);
  });
});

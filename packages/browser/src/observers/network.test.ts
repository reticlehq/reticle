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

import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import {
  buildNetworkDetail,
  mergeNetworkDetail,
  attachNetworkDetail,
  type NetworkDetail,
  type ResponseLike,
  type PageLike,
} from './network-detail.js';

describe('buildNetworkDetail', () => {
  it('shapes an authoritative response into a NET_DETAIL payload, lower-casing header names', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/order',
      method: 'POST',
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
      resourceType: 'fetch',
    });
    expect(detail).toEqual({
      url: 'https://api.example/order',
      method: 'POST',
      status: 201,
      headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      resourceType: 'fetch',
    });
  });

  it('redacts credential headers — set-cookie/cookie/authorization never reach the journal or the agent', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/login',
      method: 'POST',
      status: 200,
      // The CDP path sees the full response headers; the SDK's in-page wrapper structurally cannot.
      headers: {
        'Set-Cookie': 'session=s3cr3t; HttpOnly',
        Authorization: 'Bearer abc.def.ghi',
        Cookie: 'session=s3cr3t',
        'Content-Type': 'application/json',
      },
    });
    expect(detail.headers).toEqual({
      'set-cookie': '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'content-type': 'application/json',
    });
  });

  it('scrubs a known secret SHAPE echoed in an otherwise-benign header', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/x',
      method: 'GET',
      status: 200,
      headers: { 'X-Debug-Token': 'eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe' }, // a JWT under a non-sensitive key
    });
    expect(detail.headers['x-debug-token']).toBe('[REDACTED]');
  });
});

describe('mergeNetworkDetail', () => {
  const req = (url: string, method: string): ReticleEvent => ({
    t: 1,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: { url, method, status: 200 },
  });
  const detail = (url: string, method: string, headers: Record<string, string>): ReticleEvent => ({
    t: 2,
    type: EventType.NET_DETAIL,
    sessionId: 's',
    data: { url, method, status: 200, headers },
  });

  it('folds authoritative headers onto the matching in-page NET_REQUEST (by url+method)', () => {
    const merged = mergeNetworkDetail([
      req('/api/order', 'POST'),
      detail('/api/order', 'POST', { 'content-type': 'application/json' }),
    ]);
    const request = merged.find((e) => e.type === EventType.NET_REQUEST);
    expect(request?.data['headers']).toEqual({ 'content-type': 'application/json' });
    // The now-redundant NET_DETAIL is dropped from the merged view (its detail lives on the request).
    expect(merged.some((e) => e.type === EventType.NET_DETAIL)).toBe(false);
  });

  it('keeps an unmatched NET_DETAIL as its own event (never silently dropped)', () => {
    const merged = mergeNetworkDetail([detail('/api/other', 'GET', { etag: 'v1' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe(EventType.NET_DETAIL);
  });

  it('does not clobber headers the in-page event already carries', () => {
    const withHeaders: ReticleEvent = {
      t: 1,
      type: EventType.NET_REQUEST,
      sessionId: 's',
      data: { url: '/x', method: 'GET', status: 200, headers: { 'x-app': '1' } },
    };
    const merged = mergeNetworkDetail([withHeaders, detail('/x', 'GET', { 'x-cdp': '2' })]);
    expect(merged.find((e) => e.type === EventType.NET_REQUEST)?.data['headers']).toEqual({
      'x-app': '1',
    });
  });
});

describe('attachNetworkDetail', () => {
  it('emits a NET_DETAIL for each response the page reports', async () => {
    const events: NetworkDetail[] = [];
    let handler: ((res: ResponseLike) => void) | undefined;
    const page: PageLike = {
      url: () => 'http://app.test/',
      on: (event: 'response', fn: (res: ResponseLike) => void) => {
        if ('response' === event) handler = fn;
      },
    };
    attachNetworkDetail(page, (data) => events.push(data));
    // Simulate a Playwright Response.
    handler?.({
      url: () => 'https://api/x',
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html' }),
      request: () => ({ method: () => 'GET', resourceType: () => 'document' }),
    });
    await Promise.resolve(); // flush the async headers → emit microtask
    await Promise.resolve();
    expect(events[0]).toMatchObject({ url: 'https://api/x', status: 200, method: 'GET' });
  });
});

/**
 * The wire body, for the one blind spot in-page instrumentation cannot cover.
 *
 * Reticle reads `init.body` inside its OWN fetch wrapper, so it records what the page HANDED to
 * fetch — not what left the machine. Whoever patches fetch last is outermost, and app bootstrap
 * decides that, not us: an axios/auth/analytics interceptor initialised after connect(), or a service
 * worker (which produces no window.fetch frame at all), can rewrite a request invisibly. Our own
 * benchmark has a bug of exactly this shape that Playwright catches and we miss.
 *
 * On the DRIVE path the daemon owns the browser and can read the request as the network stack sees
 * it, which closes the gap for that path. It does nothing for attach-mode sessions, and the tests
 * below are the contract for the half that is fixable.
 */
describe('authoritative request body', () => {
  const ev = (type: EventType, data: Record<string, unknown>): ReticleEvent => ({
    t: 1,
    type,
    sessionId: 's',
    data,
  });

  it('carries the wire body onto the detail', () => {
    const d = buildNetworkDetail({
      url: 'https://api.test/generate',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: '{"prompt":"hello"}',
    });
    expect(d.requestBody).toBe('{"prompt":"hello"}');
  });

  it('redacts credentials in the wire body — it is raw and unscrubbed from Playwright', () => {
    const d = buildNetworkDetail({
      url: 'https://api.test/login',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: '{"password":"hunter2","token":"sk_live_abcdefghijklmnop"}',
    });
    expect(d.requestBody).not.toContain('hunter2');
    expect(d.requestBody).not.toContain('sk_live_abcdefghijklmnop');
  });

  it('redacts a sensitive key with a NON-string value — the gap that leaked', () => {
    // The old string-only sweep matched exclusively `"key":"string"`, so a numeric PIN, a token
    // array, or a nested credential object under a sensitive key sailed straight through to the
    // agent and the on-disk journal. A structural pass redacts by key whatever the value type.
    const d = buildNetworkDetail({
      url: 'https://api.test/login',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody:
        '{"password":1234,"apiKey":{"v":"nested-secret"},"token":["a","b"],"ok":"visible"}',
    });
    expect(d.requestBody).not.toContain('1234');
    expect(d.requestBody).not.toContain('nested-secret');
    expect(d.requestBody).not.toContain('"a"');
    // a non-sensitive field is untouched
    expect(d.requestBody).toContain('visible');
  });

  it('still redacts the common string case in a TRUNCATED (non-JSON) body via the fallback', () => {
    // A capture cut at 8192 chars is no longer valid JSON, so the structural parse fails and the
    // string sweep must still catch the plain `"key":"string"` case.
    const long = 'x'.repeat(9000);
    const d = buildNetworkDetail({
      url: 'https://api.test/login',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: `{"password":"hunter2","blob":"${long}`,
    });
    expect(d.requestBody).not.toContain('hunter2');
  });

  it('redacts a FORM-ENCODED body — the shape a real login form POSTs', () => {
    // application/x-www-form-urlencoded is not JSON and not `"key":"string"`, so neither the
    // structural path nor the JSON regex touched it — `password=hunter2` from a plain form login
    // sailed through to the agent and the journal.
    const d = buildNetworkDetail({
      url: 'https://api.test/login',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: 'username=bob&password=hunter2&remember=true',
    });
    expect(d.requestBody).not.toContain('hunter2');
    expect(d.requestBody).toContain('username=bob');
  });

  it('bounds an enormous wire body rather than journaling it whole', () => {
    const d = buildNetworkDetail({
      url: 'https://api.test/upload',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: 'x'.repeat(500_000),
    });
    expect(d.requestBody).toBeDefined();
    expect(String(d.requestBody).length).toBeLessThanOrEqual(8_300);
  });

  it('omits the field entirely when there is no body (a GET)', () => {
    const d = buildNetworkDetail({
      url: 'https://api.test/x',
      method: 'GET',
      status: 200,
      headers: {},
    });
    expect('requestBody' in d).toBe(false);
  });

  /**
   * The in-page value is what the app INTENDED to send; the wire value is what actually went. When
   * they differ that IS the bug, so the authoritative one must win — this is the only merge field
   * that overwrites rather than filling a gap, and the reason is worth stating at the assertion.
   */
  it('overwrites the in-page body, because a disagreement is the finding', () => {
    const merged = mergeNetworkDetail([
      ev(EventType.NET_REQUEST, {
        url: 'https://api.test/generate',
        method: 'POST',
        requestBody: '{"prompt":"hello"}',
      }),
      ev(EventType.NET_DETAIL, {
        url: 'https://api.test/generate',
        method: 'POST',
        requestBody: '{}',
      }),
    ]);
    const req = merged.find((e) => e.type === EventType.NET_REQUEST);
    expect(req?.data['requestBody']).toBe('{}');
    expect(req?.data['requestBodyDivergedFromPage']).toBe(true);
  });

  it('does not flag divergence when the two agree', () => {
    const merged = mergeNetworkDetail([
      ev(EventType.NET_REQUEST, {
        url: 'https://api.test/a',
        method: 'POST',
        requestBody: '{"a":1}',
      }),
      ev(EventType.NET_DETAIL, {
        url: 'https://api.test/a',
        method: 'POST',
        requestBody: '{"a":1}',
      }),
    ]);
    const req = merged.find((e) => e.type === EventType.NET_REQUEST);
    expect(req?.data['requestBodyDivergedFromPage']).toBeUndefined();
  });
});

/**
 * Which page a wire detail belongs to.
 *
 * Routing matched the REQUEST's origin against the session's origin, with a fallback to the drive
 * URL's origin. Both fail for the ordinary case: an app on :4312 calling an API on :8787 produces a
 * detail whose origin matches no session, so it was silently dropped. On the CDP-attach path there is
 * no driveUrl either, so the fallback was an empty string and matched nothing at all.
 *
 * The document that ISSUED the request is what identifies the session, so the detail carries it.
 */
describe('network detail carries its originating page', () => {
  it('records the page url the request was issued from', () => {
    const d = buildNetworkDetail({
      url: 'http://localhost:8787/api/generate',
      method: 'POST',
      status: 200,
      headers: {},
      pageUrl: 'http://localhost:4312/?reticle-bug=x',
    });
    expect(d.pageUrl).toBe('http://localhost:4312/?reticle-bug=x');
  });

  it('omits it when the driver could not say', () => {
    const d = buildNetworkDetail({ url: 'http://x/y', status: 200, headers: {} });
    expect('pageUrl' in d).toBe(false);
  });

  it('attach passes the page url through, so cross-origin calls stay attributable', async () => {
    const seen: NetworkDetail[] = [];
    const page: PageLike = {
      url: () => 'http://localhost:4312/dashboard',
      on: (_e, handler) => {
        void handler({
          url: () => 'http://localhost:8787/api/generate',
          status: () => 200,
          headers: () => ({}),
          request: () => ({ method: () => 'POST', postData: () => '{"prompt":"hi"}' }),
        });
      },
    };
    attachNetworkDetail(page, (d) => seen.push(d));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]?.pageUrl).toBe('http://localhost:4312/dashboard');
    expect(seen[0]?.requestBody).toBe('{"prompt":"hi"}');
  });
});

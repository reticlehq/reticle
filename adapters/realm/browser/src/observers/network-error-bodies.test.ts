/**
 * A failed request's body is the one that says why, and it was the one dropped by default (#800).
 *
 * `POST /auth/v1/signup -> 500, responseSize: 74`. Reticle knew the status, the content type and
 * the duration; the 74 bytes said the mail provider refuses this domain. Recovering them meant
 * editing the app's instrumentation, restarting the dev server, re-driving a multi-field form and
 * re-submitting against a rate-limited path — not a retry worth paying for one small payload.
 *
 * These tests pin the narrow scope that keeps this compatible with #705 (bodies off by default,
 * because a first drive buffered authenticated payloads): failures only, capped, redacted, and
 * switchable off.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installNetwork } from './network.js';
import type { Emit, Teardown } from './types.js';

const teardowns: Teardown[] = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) t();
  vi.unstubAllGlobals();
});

function collect(): { emit: Emit; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return { emit: (type, data) => events.push({ type, data }), events };
}

/** The body is emitted from a detached promise so the app never waits; let it land. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function response(status: number, body: string, contentType = 'application/json'): Response {
  const res = {
    headers: { get: (k: string) => ('content-type' === k.toLowerCase() ? contentType : null) },
    status,
    ok: status >= 200 && status < 400,
    statusText: '',
    clone: () => ({ text: () => Promise.resolve(body) }),
  };
  return res as unknown as Response;
}

function stubFetch(res: Response): void {
  vi.stubGlobal('fetch', () => Promise.resolve(res));
}

async function driveFetch(
  res: Response,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown> | undefined> {
  const { emit, events } = collect();
  stubFetch(res);
  teardowns.push(installNetwork(emit, options));
  await fetch('https://app.test/auth/v1/signup', { method: 'POST' });
  await flush();
  return events.find((e) => e.data['url'] !== undefined && e.data['status'] !== undefined)?.data;
}

const CAUSE = '{"message":"Error sending confirmation email","code":"mail_refused"}';

describe('a failed response keeps the bytes that say why', () => {
  it('captures the body of a 500 with body capture OFF', async () => {
    const data = await driveFetch(response(500, CAUSE));
    expect(data?.['responseBody']).toBe(CAUSE);
  });

  it('says WHY the body is present, so an absent 200 body is not misread', async () => {
    // Without this, a reader seeing a body on the 500 could conclude capture is on and treat an
    // absent body on a 200 as "the response was empty" rather than "it was never recorded".
    const data = await driveFetch(response(500, CAUSE));
    expect(data?.['responseBodyReason']).toBe('error-status');
  });

  it('captures a 4xx too — a 400 validation payload is the same kind of evidence', async () => {
    const data = await driveFetch(response(400, '{"field":"email","error":"taken"}'));
    expect(data?.['responseBody']).toContain('taken');
  });
});

describe('the volume case #705 is about stays untouched', () => {
  it('does not capture a 200 body', async () => {
    const data = await driveFetch(response(200, '{"rows":[1,2,3]}'));
    expect(data?.['responseBody']).toBeUndefined();
  });

  it('does not capture a 3xx body — a redirect is a successful navigation', async () => {
    const data = await driveFetch(response(302, 'moved'));
    expect(data?.['responseBody']).toBeUndefined();
  });

  it('is switchable off entirely for a workspace that wants nothing retained', async () => {
    const data = await driveFetch(response(500, CAUSE), { captureErrorBodies: false });
    expect(data?.['responseBody']).toBeUndefined();
    expect(data?.['status'], 'the failure is still reported, only its body is not').toBe(500);
  });
});

describe('the error body is capped and redacted like any other', () => {
  it('truncates past the error cap and says so', async () => {
    const data = await driveFetch(response(500, JSON.stringify({ m: 'x'.repeat(20_000) })));
    expect(data?.['responseBodyTruncated']).toBe(true);
    expect(String(data?.['responseBody']).length).toBeLessThanOrEqual(4096);
  });

  it('redacts a credential in a failure payload before retaining it', async () => {
    const data = await driveFetch(
      response(401, '{"error":"bad token","password":"hunter2-not-a-real-secret"}'),
    );
    expect(String(data?.['responseBody'])).not.toContain('hunter2-not-a-real-secret');
  });

  it('leaves a full-capture run projecting failures exactly as before', async () => {
    const data = await driveFetch(response(500, CAUSE), { captureBodies: true });
    expect(data?.['responseBody']).toBe(CAUSE);
    expect(
      data?.['responseBodyReason'],
      'the marker is only for the error-only path',
    ).toBeUndefined();
  });
});

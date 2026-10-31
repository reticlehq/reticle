/**
 * A file the server sends as a download must reach the network record on a driven page.
 *
 * Measured on Chromium: a click that becomes a download fires no page `request`/`response` event and
 * no CDP `Network.responseReceived` on the page, and a Playwright route does not intercept it. CDP
 * request interception at the response stage (`Fetch.requestPaused`) does see it, with its status
 * and headers. These tests pin what the capture does with that event, on a fake CDP session.
 */
import { describe, expect, it } from 'vitest';
import { attachDownloadCapture, type CdpLike } from './download-capture.js';
import type { NetworkDetail } from './network-detail.js';

class FakeCdp implements CdpLike {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  #handler: ((event: unknown) => void) | undefined;

  body = 'short_url,target\r\nhttp://x/u02,"Sale, 50% off"\r\n';

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push(params === undefined ? { method } : { method, params });
    if ('Fetch.getResponseBody' === method) {
      return Promise.resolve({
        body: Buffer.from(this.body).toString('base64'),
        base64Encoded: true,
      });
    }
    return Promise.resolve({});
  }

  on(event: string, handler: (event: unknown) => void): void {
    if ('Fetch.requestPaused' === event) {
      this.#handler = handler;
    }
  }

  pause(event: Record<string, unknown>): void {
    this.#handler?.(event);
  }
}

function paused(
  headers: Array<{ name: string; value: string }>,
  status = 200,
): Record<string, unknown> {
  return {
    requestId: 'r1',
    request: { url: 'http://localhost:3500/api/links/export?search=u0', method: 'GET' },
    resourceType: 'Document',
    responseStatusCode: status,
    responseHeaders: headers,
  };
}

async function setUp(): Promise<{ cdp: FakeCdp; details: NetworkDetail[] }> {
  const cdp = new FakeCdp();
  const details: NetworkDetail[] = [];
  await attachDownloadCapture(
    cdp,
    (d) => details.push(d),
    () => 'http://localhost:3500/',
  );
  return { cdp, details };
}

describe('download capture on a driven page', () => {
  it('intercepts document responses only', async () => {
    const { cdp } = await setUp();
    const enable = cdp.sent.find((s) => 'Fetch.enable' === s.method);
    expect(enable?.params).toEqual({
      patterns: [{ resourceType: 'Document', requestStage: 'Response' }],
    });
  });

  it('records an attachment response with its status and headers', async () => {
    const { cdp, details } = await setUp();
    cdp.pause(paused([{ name: 'Content-Disposition', value: 'attachment; filename="links.csv"' }]));
    expect(details).toHaveLength(1);
    expect(details[0]?.status).toBe(200);
    expect(details[0]?.method).toBe('GET');
    expect(details[0]?.url).toContain('/api/links/export');
    expect(details[0]?.headers?.['content-disposition']).toContain('attachment');
  });

  it('records nothing for an ordinary document', async () => {
    const { cdp, details } = await setUp();
    cdp.pause(paused([{ name: 'content-type', value: 'text/html' }]));
    expect(details).toHaveLength(0);
  });

  it('always lets the response through, so a page never stalls', async () => {
    const { cdp } = await setUp();
    cdp.pause(paused([{ name: 'content-type', value: 'text/html' }]));
    cdp.pause(paused([{ name: 'content-disposition', value: 'attachment' }]));
    expect(cdp.sent.filter((s) => 'Fetch.continueRequest' === s.method)).toHaveLength(2);
  });

  it('lets the response through even when recording it fails', async () => {
    const cdp = new FakeCdp();
    await attachDownloadCapture(
      cdp,
      () => {
        throw new Error('sink failed');
      },
      () => 'http://localhost:3500/',
    );
    cdp.pause(paused([{ name: 'content-disposition', value: 'attachment' }]));
    expect(cdp.sent.filter((s) => 'Fetch.continueRequest' === s.method)).toHaveLength(1);
  });

  it('records the body of a small text attachment, so a body check can run', async () => {
    const { cdp, details } = await setUp();
    cdp.pause(
      paused([
        { name: 'content-disposition', value: 'attachment; filename="links.csv"' },
        { name: 'content-type', value: 'text/csv; charset=utf-8' },
        { name: 'content-length', value: '60' },
      ]),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(details[0]?.responseBody).toContain('"Sale, 50% off"');
    expect(cdp.sent.filter((s) => 'Fetch.continueRequest' === s.method)).toHaveLength(1);
  });

  it('does not read the body of a large or binary attachment', async () => {
    const { cdp, details } = await setUp();
    cdp.pause(
      paused([
        { name: 'content-disposition', value: 'attachment; filename="big.zip"' },
        { name: 'content-type', value: 'application/zip' },
        { name: 'content-length', value: '50000000' },
      ]),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(details[0]?.responseBody).toBeUndefined();
    expect(cdp.sent.some((s) => 'Fetch.getResponseBody' === s.method)).toBe(false);
  });

  it('says when the recorded body was cut', async () => {
    const cdp = new FakeCdp();
    cdp.body = 'x'.repeat(20_000);
    const details: NetworkDetail[] = [];
    await attachDownloadCapture(
      cdp,
      (d) => details.push(d),
      () => 'http://localhost:3500/',
    );
    cdp.pause(
      paused([
        { name: 'content-disposition', value: 'attachment' },
        { name: 'content-type', value: 'text/plain' },
        { name: 'content-length', value: '20000' },
      ]),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(details[0]?.responseBodyTruncated).toBe(true);
  });
});

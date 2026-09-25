import { describe, expect, it, vi } from 'vitest';
import { hasConnectedDocument, observeWebDocument } from './web-csp-observation.js';

describe('observeWebDocument', () => {
  it('returns the effective response policy and served HTML from a loopback page', async () => {
    const quote = String.fromCharCode(34);
    const html = `<meta http-equiv=${quote}Content-Security-Policy${quote} content=${quote}connect-src 'self'${quote}>`;
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(html, {
          headers: { 'content-security-policy': `script-src 'self' 'unsafe-inline'` },
        }),
      ),
    );

    await expect(observeWebDocument('http://localhost:3000/', request)).resolves.toEqual({
      url: 'http://localhost:3000/',
      headers: [`script-src 'self' 'unsafe-inline'`],
      html,
    });
  });

  it('refuses a non-loopback URL rather than turning doctor into an HTTP client', async () => {
    const request = vi.fn();
    await expect(observeWebDocument('https://example.com/', request)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('degrades an unreachable development page to no observation', async () => {
    const request = vi.fn(async () => Promise.reject(new Error('offline')));
    await expect(observeWebDocument('http://127.0.0.1:5173/', request)).resolves.toBeUndefined();
  });
});

describe('hasConnectedDocument', () => {
  it('matches another path on the same development origin', () => {
    expect(
      hasConnectedDocument([{ url: 'http://localhost:3000/settings' }], ['http://localhost:3000/']),
    ).toBe(true);
  });

  it(`does not let a different local app suppress this project's finding`, () => {
    expect(
      hasConnectedDocument([{ url: 'http://localhost:5173/' }], ['http://localhost:3000/']),
    ).toBe(false);
  });

  it('uses the build-stamped project identity even without a dev-server registry entry', () => {
    expect(
      hasConnectedDocument([{ url: 'http://localhost:3000/', projectId: 'shop' }], [], 'shop'),
    ).toBe(true);
    expect(
      hasConnectedDocument([{ url: 'http://localhost:3000/', projectId: 'blog' }], [], 'shop'),
    ).toBe(false);
  });
});

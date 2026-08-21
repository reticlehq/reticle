import { describe, expect, it } from 'vitest';
import { authorized, previewAllowed, publicResponse, tokenMatches } from './http.js';

describe('public Worker routes', () => {
  it('shows a friendly ready page at the Worker root', async () => {
    const response = publicResponse(new Request('https://worker.example/'));

    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('text/html');
    await expect(response?.text()).resolves.toContain('Reticle Cloudflare Runner');
    expect(publicResponse(new Request('https://worker.example/missing'))).toBeUndefined();
  });
});

describe('worker request security', () => {
  it('requires the complete bearer token', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('secre', 'secret')).toBe(false);
    expect(tokenMatches('secret-extra', 'secret')).toBe(false);
    expect(authorized(new Request('https://worker/v1/flows'), 'secret')).toBe(false);
    expect(
      authorized(
        new Request('https://worker/v1/flows', {
          headers: { authorization: 'Bearer secret' },
        }),
        'secret',
      ),
    ).toBe(true);
  });

  it('refuses local/private browser targets', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://10.2.3.4',
      'http://172.16.1.1',
      'http://192.168.1.2',
      'http://169.254.169.254',
      'http://[::1]',
      'http://[fd00::1]',
      'file:///etc/passwd',
    ]) {
      expect(previewAllowed(url, undefined), url).toBe(false);
    }
    expect(previewAllowed('https://example.com', undefined)).toBe(true);
  });

  it('honors an exact-or-suffix preview host allowlist', () => {
    const allowlist = 'preview.example.com,.pages.dev';
    expect(previewAllowed('https://preview.example.com/x', allowlist)).toBe(true);
    expect(previewAllowed('https://branch.pages.dev', allowlist)).toBe(true);
    expect(previewAllowed('https://example.com', allowlist)).toBe(false);
  });
});

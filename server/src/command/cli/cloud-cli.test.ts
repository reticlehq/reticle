import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloudCommand } from './cloud-cli.js';

describe('cloud-cli api() JSON parse guard', () => {
  const origFetch = globalThis.fetch;
  const origStderr = process.stderr.write.bind(process.stderr);
  let stderrBuf: string;

  beforeEach(() => {
    stderrBuf = '';
    process.stderr.write = (chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    };
    process.env['RETICLE_CLOUD_KEY'] = 'test-key';
    process.env['RETICLE_CLOUD_URL'] = 'http://localhost:9999';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    process.stderr.write = origStderr;
    delete process.env['RETICLE_CLOUD_KEY'];
    delete process.env['RETICLE_CLOUD_URL'];
  });

  /*
   * From a CI drive: with a revoked key set, `reticle runs regression` said "sign in or API key
   * required" — the platform's generic 401 — although a key WAS set. It was refused, and that is
   * what the person has to act on.
   */
  it('says a set API key was refused, not that one is missing', async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('{"error":{"message":"sign in or API key required"}}'),
      })) as unknown as typeof fetch;
    const code = await runCloudCommand(['project', 'ls']);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('refused this API key (401)');
    expect(stderrBuf).not.toContain('sign in or API key required');
  });

  it('surfaces an actionable error when the response is not JSON (proxy HTML)', async () => {
    const html = '<html><body>Login Required</body></html>';
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(html),
      })) as unknown as typeof fetch;

    const code = await runCloudCommand(['project', 'ls']);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('expected JSON');
    expect(stderrBuf).toContain('GET');
    expect(stderrBuf).toContain('Login Required');
  });
});

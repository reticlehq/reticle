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
    const code = await runCloudCommand(['runs', 'regression']);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('refused this API key (401)');
    expect(stderrBuf).not.toContain('sign in or API key required');
  });

  // The platform now names why a key it knows was refused; that sentence is the answer.
  it.each([
    ['removed_from_workspace', 'You were removed from Acme.'],
    ['key_lost_access', "This API key's owner no longer has access to the project web."],
  ])('says the reason the platform gave (%s)', async (code, message) => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve(JSON.stringify({ error: { code, message } })),
      })) as unknown as typeof fetch;
    expect(await runCloudCommand(['runs', 'regression'])).toBe(1);
    expect(stderrBuf).toContain(message.replace(/\.$/, ''));
    expect(stderrBuf).not.toContain('it was revoked');
  });

  it('surfaces an actionable error when the response is not JSON (proxy HTML)', async () => {
    const html = '<html><body>Login Required</body></html>';
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(html),
      })) as unknown as typeof fetch;

    const code = await runCloudCommand(['runs', 'regression']);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('expected JSON');
    expect(stderrBuf).toContain('GET');
    expect(stderrBuf).toContain('Login Required');
  });
});

/*
 * The Harness is off until the user switches it on, because every drive spends the workspace's
 * credits. The refusal used to point at two screens; it now names one command, and this is it.
 */
describe('reticle config --harness on|off', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env['RETICLE_API_KEY'];
    delete process.env['RETICLE_CLOUD_URL'];
  });

  it('writes the switch to the platform with the project key', async () => {
    process.env['RETICLE_API_KEY'] = 'rk_live_test';
    process.env['RETICLE_CLOUD_URL'] = 'http://localhost:9999';
    const sent: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = ((url: string, init: { method: string; body: string }) => {
      sent.push({ url, method: init.method, body: init.body });
      return Promise.resolve({ ok: true, status: 200 });
    }) as unknown as typeof fetch;
    expect(await runCloudCommand(['config', '--harness', 'on'])).toBe(0);
    expect(sent).toEqual([
      {
        url: 'http://localhost:9999/v1/model/config',
        method: 'PUT',
        body: JSON.stringify({ harnessEnabled: true }),
      },
    ]);
  });

  it('the Harness-off refusal names that command', async () => {
    const { MSG_HARNESS_DISABLED } = await import('@/features/harness/platform/refusal.js');
    expect(MSG_HARNESS_DISABLED).toContain('npx @reticlehq/server config --harness on');
  });
});

import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { zeroInstallScript } from './zero-install.js';

/** A stand-in for the SDK bundle: evaluating it creates the singleton, exactly as the real one does. */
const FAKE_BUNDLE =
  'globalThis.__reticleInstance = { connect(a) { globalThis.__connectedWith = a; }, own: false };';
const OPTS = { url: 'ws://localhost:4400/reticle', token: 'tok' };

function run(sandbox: Record<string, unknown>): Record<string, unknown> {
  sandbox['globalThis'] = sandbox;
  runInNewContext(zeroInstallScript(FAKE_BUNDLE, OPTS), sandbox);
  return sandbox;
}

describe('zeroInstallScript — the reader a page with no SDK is given', () => {
  it('installs the SDK and connects it to this daemon with the pairing token', () => {
    const page = run({});
    expect(page['__connectedWith']).toEqual({
      allowNonLocalhost: true,
      token: 'tok',
      url: OPTS.url,
    });
  });

  // A page that DID load an SDK keeps its own instance: a second copy would be a second session.
  it('leaves an SDK the page already has in place, and only connects it', () => {
    const own = {
      connect(a: unknown) {
        page['__connectedWith'] = a;
      },
      own: true,
    };
    const page: Record<string, unknown> = { __reticleInstance: own };
    run(page);
    expect(page['__reticleInstance']).toBe(own);
    expect(page['__connectedWith']).toEqual({
      allowNonLocalhost: true,
      token: 'tok',
      url: OPTS.url,
    });
  });
});

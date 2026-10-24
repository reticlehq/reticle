import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { READER_NOT_HTML, readReaderBundle, zeroInstallScript } from './zero-install.js';

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
      lease: true,
      token: 'tok',
      url: OPTS.url,
    });
  });

  // A page that DID load an SDK keeps its own instance: a second copy would be a second session.
  // The call is marked `lease`, so that SDK takes the daemon's token if the bridge refused its own.
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
      lease: true,
      token: 'tok',
      url: OPTS.url,
    });
  });

  // #1701 reports `Cannot read properties of null (reading 'appendChild')` on an `.svg` URL.
  it('does nothing on a document that is not HTML, and returns the not-HTML answer', () => {
    const page: Record<string, unknown> = {
      document: { contentType: 'image/svg+xml' },
    };
    page['globalThis'] = page;
    expect(runInNewContext(zeroInstallScript(FAKE_BUNDLE, OPTS), page)).toBe(READER_NOT_HTML);
    expect(page['__reticleInstance']).toBeUndefined();
    expect(page['__connectedWith']).toBeUndefined();
  });

  it('connects on an HTML or XHTML document', () => {
    for (const contentType of ['text/html', 'application/xhtml+xml']) {
      const page = run({ document: { contentType } });
      expect(page['__connectedWith']).toEqual({
        allowNonLocalhost: true,
        lease: true,
        token: 'tok',
        url: OPTS.url,
      });
    }
  });
});

/*
 * The package ships ONE single-file build, and it has two readers: this daemon, which evaluates it
 * as a script, and webpack 4 (#680), which reads the `module` field and parses it as CommonJS. Each
 * reader used to get its own ~550KB copy, which is what took the SDK past its size budget.
 */
describe('the single-file build — one copy for the reader and for webpack 4', () => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@reticlehq/browser/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { module?: string };

  it('is the file the `module` field points at', () => {
    expect(join(dirname(pkgPath), pkg.module ?? '')).toBe(
      require.resolve('@reticlehq/browser/inject'),
    );
  });

  it('loads as CommonJS and exports the SDK, so a webpack 4 import still resolves', () => {
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    runInNewContext(readReaderBundle() ?? '', { module: mod });
    expect(mod.exports['__esModule']).toBe(true);
    expect(typeof mod.exports['reticle']).toBe('object');
  });
});

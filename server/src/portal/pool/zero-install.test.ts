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
 * A zero-install lease lost its session on every full navigation after the first page: a login that
 * moved to /lab, a route change in a Next.js app, `reticle_navigate`. The reader runs again on each
 * new document as an init script, before the parser makes <head> and <body>. `connect()` mounts
 * page UI before it dials the bridge, threw on the null <head>, and never dialled.
 */
describe('zeroInstallScript — on a document the parser has not built yet', () => {
  function loadingPage(): { page: Record<string, unknown>; fire: () => void } {
    let handler: (() => void) | undefined;
    const page: Record<string, unknown> = {
      document: {
        contentType: 'text/html',
        readyState: 'loading',
        addEventListener: (type: string, fn: () => void) => {
          if ('DOMContentLoaded' === type) {
            handler = fn;
          }
        },
      },
    };
    return { page, fire: () => handler?.() };
  }

  it('waits for the DOM before it connects', () => {
    const { page, fire } = loadingPage();
    run(page);
    expect(page['__reticleInstance']).toBeDefined();
    expect(page['__connectedWith']).toBeUndefined();
    fire();
    expect(page['__connectedWith']).toMatchObject({ lease: true, token: 'tok' });
  });

  it('connects at once when the DOM is already there', () => {
    const page = run({ document: { contentType: 'text/html', readyState: 'interactive' } });
    expect(page['__connectedWith']).toMatchObject({ lease: true });
  });
});

/*
 * The reader connects at DOMContentLoaded, and the SDK installs its observers in `connect()`. A
 * console error or an uncaught error from the app's start-up scripts came before that, so a page
 * that crashed while it loaded gave a clean capture: a smoke check on it said "yes". The script now
 * keeps what the page said before the observers existed and hands it to them once they do.
 */
describe('zeroInstallScript — what the page said before the observers were installed', () => {
  /** A bundle whose `connect` patches console.error and listens for errors, as the SDK does. */
  const RECORDING_BUNDLE =
    'globalThis.__reticleInstance = { connect(a) {' +
    ' const prior = globalThis.console.error;' +
    ' globalThis.console.error = (...args) => { globalThis.__seen.push(["console", args.join(" ")]); prior(...args); };' +
    ' globalThis.addEventListener("error", (e) => globalThis.__seen.push(["error", e.message]), true);' +
    ' globalThis.addEventListener("unhandledrejection", (e) => globalThis.__seen.push(["rejection", String(e.reason)]));' +
    ' } };';

  class FakeErrorEvent extends Event {
    readonly message: string;
    constructor(type: string, init: { message?: string } = {}) {
      super(type);
      this.message = init.message ?? '';
    }
  }
  class FakeRejectionEvent extends Event {
    readonly reason: unknown;
    readonly promise: unknown;
    constructor(type: string, init: { reason?: unknown; promise?: unknown } = {}) {
      super(type);
      this.reason = init.reason;
      this.promise = init.promise;
    }
  }

  it('hands the start-up console errors and uncaught errors to the observers, and prints each once', () => {
    let fire: (() => void) | undefined;
    const printed: string[] = [];
    const target = new EventTarget();
    const page: Record<string, unknown> = {
      __seen: [],
      console: { error: (...args: unknown[]) => printed.push(args.join(' ')) },
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      ErrorEvent: FakeErrorEvent,
      PromiseRejectionEvent: FakeRejectionEvent,
      document: {
        contentType: 'text/html',
        readyState: 'loading',
        addEventListener: (type: string, fn: () => void) => {
          if ('DOMContentLoaded' === type) {
            fire = fn;
          }
        },
      },
    };
    page['globalThis'] = page;
    runInNewContext(zeroInstallScript(RECORDING_BUNDLE, OPTS), page);
    const appConsole = page['console'] as { error: (...a: unknown[]) => void };
    // The app's start-up scripts, before the DOM is ready.
    appConsole.error('start-up', 'failed');
    target.dispatchEvent(new FakeErrorEvent('error', { message: 'Uncaught TypeError: x' }));
    target.dispatchEvent(new FakeRejectionEvent('unhandledrejection', { reason: 'no data' }));
    fire?.();
    // After connect, the app's own errors reach the observers once, as before.
    (page['console'] as { error: (...a: unknown[]) => void }).error('later');
    expect(page['__seen']).toEqual([
      ['console', 'start-up failed'],
      ['error', 'Uncaught TypeError: x'],
      ['rejection', 'no data'],
      ['console', 'later'],
    ]);
    expect(printed).toEqual(['start-up failed', 'later']);
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

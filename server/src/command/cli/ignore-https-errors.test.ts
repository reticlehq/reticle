/**
 * `--ignore-https-errors` on the CLI paths (#1713).
 *
 * `reticle_lease { ignoreHTTPSErrors: true }` already accepted a self-signed or mkcert dev
 * certificate. The CLI had no equal: `serve --drive`, `drive` and `verify` failed with
 * `net::ERR_CERT_AUTHORITY_INVALID`, and an agent without the MCP tools had no other route.
 *
 * These tests pin the three things the issue asks for: every command reads the flag, the option
 * survives the trip to the process that launches the browser, and the failure names the flag when it
 * was not passed.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';
import { daemonSpawnArgs, daemonStartOptions } from './daemon-start-options.js';
import { LaunchedRealInputProvider, navigationFailureMessage } from '@/portal/input/real-input.js';
import { resolveRealInput } from '@/start-wiring.js';

const URL_ = 'https://localhost:5173';
const FLAG = '--ignore-https-errors';

describe('every CLI path that opens a browser reads --ignore-https-errors', () => {
  it.each([
    ['serve --drive', ['serve', '--drive', URL_, FLAG]],
    ['mcp --drive', ['mcp', '--drive', URL_, FLAG]],
    ['_daemon --drive', ['_daemon', '--drive', URL_, FLAG]],
    ['drive', ['drive', URL_, FLAG]],
    ['verify', ['verify', URL_, FLAG]],
  ])('%s accepts it', (_label, argv) => {
    expect(parseCliArgs(argv, 4400)).toMatchObject({ ignoreHTTPSErrors: true });
  });

  it.each([
    ['serve', ['serve', '--drive', URL_]],
    ['mcp', ['mcp', '--drive', URL_]],
    ['_daemon', ['_daemon', '--drive', URL_]],
    ['drive', ['drive', URL_]],
    ['verify', ['verify', URL_]],
  ])('%s leaves certificate checks on unless asked', (_label, argv) => {
    expect(parseCliArgs(argv, 4400)).not.toHaveProperty('ignoreHTTPSErrors');
  });
});

describe('the flag survives the trip to the daemon that launches the browser', () => {
  const flags = { port: 4400, headless: true, http: false, ignoreHTTPSErrors: true };

  it('reaches startDaemon', () => {
    expect(daemonStartOptions(flags).ignoreHTTPSErrors).toBe(true);
  });

  it('reaches the detached child', () => {
    expect(daemonSpawnArgs(flags)).toContain(FLAG);
  });

  it('is absent from the child when not asked', () => {
    expect(daemonSpawnArgs({ port: 4400, headless: true, http: false })).not.toContain(FLAG);
  });
});

describe('the driven context accepts the certificate only when asked', () => {
  function fakeProvider(seen: { opts?: unknown }, gotoFailure?: Error) {
    const page = {
      addInitScript: () => Promise.resolve(),
      goto: () => (gotoFailure === undefined ? Promise.resolve(null) : Promise.reject(gotoFailure)),
    };
    const browser = {
      newPage: (opts?: unknown) => {
        seen.opts = opts;
        return Promise.resolve(page);
      },
    };
    return new LaunchedRealInputProvider({
      driveUrl: URL_,
      headless: true,
      launch: () => Promise.resolve(browser as never),
      sleep: () => Promise.resolve(),
    });
  }

  it('opens the page with ignoreHTTPSErrors when the flag is given', async () => {
    const seen: { opts?: unknown } = {};
    const provider = new LaunchedRealInputProvider({
      driveUrl: URL_,
      headless: true,
      ignoreHTTPSErrors: true,
      launch: () =>
        Promise.resolve({
          newPage: (opts?: unknown) => {
            seen.opts = opts;
            return Promise.resolve({
              addInitScript: () => Promise.resolve(),
              goto: () => Promise.resolve(null),
            });
          },
        } as never),
      sleep: () => Promise.resolve(),
    });

    await provider.navigate();

    expect(seen.opts).toMatchObject({ ignoreHTTPSErrors: true });
  });

  it('leaves certificate checks on by default', async () => {
    const seen: { opts?: unknown } = {};
    await fakeProvider(seen).navigate();
    expect(seen.opts).not.toHaveProperty('ignoreHTTPSErrors');
  });
});

describe('resolveRealInput hands the option to the provider it builds', () => {
  it('passes it through', async () => {
    let seen: { ignoreHTTPSErrors?: boolean } | undefined;
    const fake = {
      navigate: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    };

    await resolveRealInput(
      {
        driveUrl: URL_,
        headless: true,
        ignoreHTTPSErrors: true,
        realInputFactory: (opts) => {
          seen = opts;
          return fake as never;
        },
      },
      () => Promise.resolve(),
    );

    expect(seen?.ignoreHTTPSErrors).toBe(true);
  });
});

describe('a navigation the certificate stopped', () => {
  const refused =
    'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://localhost:5173/\nCall log:';

  it('names the flag that accepts a dev certificate', () => {
    const message = navigationFailureMessage(refused, false);
    expect(message).toContain('net::ERR_CERT_AUTHORITY_INVALID');
    expect(message).toContain(FLAG);
  });

  it('does not repeat the flag when it was already passed', () => {
    expect(navigationFailureMessage(refused, true)).toBe(refused);
  });

  it('leaves a refused connection as it was', () => {
    expect(
      navigationFailureMessage(
        'page.goto: net::ERR_CONNECTION_REFUSED at https://localhost:5173/',
        false,
      ),
    ).not.toContain(FLAG);
  });
});

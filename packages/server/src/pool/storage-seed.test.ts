import { describe, expect, it } from 'vitest';
import type { InitScriptHandle, PooledContext, PooledCookie, PooledPage } from './browser-pool.js';
import { normalizeCookies, seedStorageInto, targetOriginOf } from './storage-seed.js';

describe('storage-seed', () => {
  describe('normalizeCookies', () => {
    it('returns empty array when cookies is undefined', () => {
      expect(normalizeCookies(undefined, 'http://localhost:3000')).toEqual([]);
    });

    it('normalizes flat record into cookies with URL origin', () => {
      const cookies = {
        auth_token: 'secret-123',
        theme: 'dark',
      };
      const normalized = normalizeCookies(cookies, 'http://localhost:3000/dashboard?a=1');
      expect(normalized).toEqual([
        { name: 'auth_token', value: 'secret-123', url: 'http://localhost:3000/' },
        { name: 'theme', value: 'dark', url: 'http://localhost:3000/' },
      ]);
    });

    it('sets path to "/" when domain is provided but path is omitted', () => {
      const cookies = [
        {
          name: 'session_id',
          value: 'sess-abc',
          domain: '.example.com',
        },
      ];
      const normalized = normalizeCookies(cookies, 'http://localhost:3000');
      expect(normalized).toEqual([
        {
          name: 'session_id',
          value: 'sess-abc',
          domain: '.example.com',
          path: '/',
        },
      ]);
    });

    it('preserves structured cookie attributes when path and domain are provided', () => {
      const cookies = [
        {
          name: 'session_id',
          value: 'sess-abc',
          domain: '.example.com',
          path: '/app',
          httpOnly: true,
          secure: true,
          sameSite: 'Strict' as const,
          expires: 1893456000,
        },
        {
          name: 'tracker',
          value: 'no',
        },
      ];
      const normalized = normalizeCookies(cookies, 'http://localhost:3000/login');
      expect(normalized).toEqual([
        {
          name: 'session_id',
          value: 'sess-abc',
          domain: '.example.com',
          path: '/app',
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
          expires: 1893456000,
        },
        {
          name: 'tracker',
          value: 'no',
          url: 'http://localhost:3000/',
        },
      ]);
    });

    it('handles malformed navigation URL gracefully by defaulting path', () => {
      const normalized = normalizeCookies({ foo: 'bar' }, 'not-a-valid-url');
      expect(normalized).toEqual([{ name: 'foo', value: 'bar', path: '/' }]);
    });
  });

  describe('targetOriginOf', () => {
    it('extracts origin from standard URLs', () => {
      expect(targetOriginOf('http://localhost:3000/app?x=1')).toBe('http://localhost:3000');
      expect(targetOriginOf('https://example.com:8080/path')).toBe('https://example.com:8080');
    });

    it('returns undefined for data: or invalid URLs', () => {
      expect(targetOriginOf('data:text/html,<h1>Hi</h1>')).toBeUndefined();
      expect(targetOriginOf('not-a-valid-url')).toBeUndefined();
    });
  });

  describe('seedStorageInto', () => {
    function makeFakes() {
      const cookiesAdded: PooledCookie[] = [];
      const initScriptsAdded: Array<{ script: unknown; arg: unknown }> = [];
      let consoleHandler: ((msg: string) => void) | undefined;
      let disposed = false;

      const fakeHandle: InitScriptHandle = {
        dispose: () => {
          disposed = true;
          return Promise.resolve();
        },
      };

      const fakeContext: PooledContext = {
        newPage: () => Promise.reject(new Error('not implemented')),
        close: () => Promise.resolve(),
        addCookies: (cookies) => {
          cookiesAdded.push(...cookies);
          return Promise.resolve();
        },
      };

      const fakePage: PooledPage = {
        goto: () => Promise.resolve(),
        close: () => Promise.resolve(),
        onCrash: () => {},
        onConsole: (handler) => {
          consoleHandler = handler;
        },
        addInitScript: (script, arg) => {
          initScriptsAdded.push({ script, arg });
          return Promise.resolve(fakeHandle);
        },
      };

      return {
        fakeContext,
        fakePage,
        cookiesAdded,
        initScriptsAdded,
        getConsoleHandler: () => consoleHandler,
        isDisposed: () => disposed,
      };
    }

    it('seeds cookies, local, and session storage with targetOrigin and returns disposable handle', async () => {
      const { fakeContext, fakePage, cookiesAdded, initScriptsAdded, isDisposed } = makeFakes();
      const seed = {
        local: { token: 'jwt-123', user: 'alice' },
        session: { tab: '42' },
        cookies: { auth: 'cookie-secret' },
      };

      const result = await seedStorageInto(
        fakeContext,
        fakePage,
        'http://localhost:3000/app',
        seed,
      );

      expect(cookiesAdded).toEqual([
        { name: 'auth', value: 'cookie-secret', url: 'http://localhost:3000/' },
      ]);
      expect(initScriptsAdded).toHaveLength(1);
      expect(initScriptsAdded[0]?.arg).toEqual({
        local: { token: 'jwt-123', user: 'alice' },
        session: { tab: '42' },
        targetOrigin: 'http://localhost:3000',
      });
      expect(result?.handle).toBeDefined();

      await result?.handle?.dispose();
      expect(isDisposed()).toBe(true);

      // Verify the initScript function writes to localStorage and sessionStorage in target window
      const initFn = initScriptsAdded[0]?.script as (arg: {
        local?: Record<string, string>;
        session?: Record<string, string>;
        targetOrigin?: string;
      }) => void;

      const mockLocal: Record<string, string> = {};
      const mockSession: Record<string, string> = {};
      const mockWindow: Record<string, unknown> = {
        location: { origin: 'http://localhost:3000' },
        localStorage: {
          setItem: (k: string, v: string) => {
            mockLocal[k] = v;
          },
        },
        sessionStorage: {
          setItem: (k: string, v: string) => {
            mockSession[k] = v;
          },
        },
      };
      mockWindow['top'] = mockWindow; // top-level

      const origGlobalWin = (globalThis as Record<string, unknown>)['window'];
      try {
        (globalThis as Record<string, unknown>)['window'] = mockWindow;
        initFn({
          local: seed.local,
          session: seed.session,
          targetOrigin: 'http://localhost:3000',
        });
      } finally {
        (globalThis as Record<string, unknown>)['window'] = origGlobalWin;
      }

      expect(mockLocal).toEqual({ token: 'jwt-123', user: 'alice' });
      expect(mockSession).toEqual({ tab: '42' });
    });

    it('skips writing local/session storage in child frames', () => {
      const { fakeContext, fakePage, initScriptsAdded } = makeFakes();
      const seed = { local: { token: 'jwt-123' } };

      void seedStorageInto(fakeContext, fakePage, 'http://localhost:3000/app', seed);
      const initFn = initScriptsAdded[0]?.script as (arg: {
        local?: Record<string, string>;
        targetOrigin?: string;
      }) => void;

      const mockLocal: Record<string, string> = {};
      const childWindow: Record<string, unknown> = {
        top: {}, // top is different object -> child iframe!
        location: { origin: 'http://localhost:3000' },
        localStorage: {
          setItem: (k: string, v: string) => {
            mockLocal[k] = v;
          },
        },
      };

      const origGlobalWin = (globalThis as Record<string, unknown>)['window'];
      try {
        (globalThis as Record<string, unknown>)['window'] = childWindow;
        initFn({
          local: seed.local,
          targetOrigin: 'http://localhost:3000',
        });
      } finally {
        (globalThis as Record<string, unknown>)['window'] = origGlobalWin;
      }

      expect(mockLocal).toEqual({}); // child frame skipped!
    });

    it('skips writing local/session storage on cross-origin redirects', () => {
      const { fakeContext, fakePage, initScriptsAdded } = makeFakes();
      const seed = { local: { token: 'jwt-123' } };

      void seedStorageInto(fakeContext, fakePage, 'http://localhost:3000/app', seed);
      const initFn = initScriptsAdded[0]?.script as (arg: {
        local?: Record<string, string>;
        targetOrigin?: string;
      }) => void;

      const mockLocal: Record<string, string> = {};
      const externalWindow: Record<string, unknown> = {
        location: { origin: 'https://auth.external.com' }, // external OAuth origin!
        localStorage: {
          setItem: (k: string, v: string) => {
            mockLocal[k] = v;
          },
        },
      };
      externalWindow['top'] = externalWindow;

      const origGlobalWin = (globalThis as Record<string, unknown>)['window'];
      try {
        (globalThis as Record<string, unknown>)['window'] = externalWindow;
        initFn({
          local: seed.local,
          targetOrigin: 'http://localhost:3000',
        });
      } finally {
        (globalThis as Record<string, unknown>)['window'] = origGlobalWin;
      }

      expect(mockLocal).toEqual({}); // external origin skipped!
    });

    it('propagates sanitized error when localStorage write fails in the browser', async () => {
      const { fakeContext, fakePage, initScriptsAdded, getConsoleHandler } = makeFakes();
      const seed = { local: { sensitive_token: 'secret-val' } };

      const result = await seedStorageInto(
        fakeContext,
        fakePage,
        'http://localhost:3000/app',
        seed,
      );
      const initFn = initScriptsAdded[0]?.script as (arg: {
        local?: Record<string, string>;
        targetOrigin?: string;
      }) => void;

      // Simulate a browser where localStorage throws QuotaExceededError
      const quotaErr = new Error('QuotaExceededError');
      quotaErr.name = 'QuotaExceededError';
      const failingWindow: Record<string, unknown> = {
        location: { origin: 'http://localhost:3000' },
        localStorage: {
          setItem: () => {
            throw quotaErr;
          },
        },
      };
      failingWindow['top'] = failingWindow;

      // Intercept console.error from initFn
      const origConsoleError = console.error;
      const origGlobalWin = (globalThis as Record<string, unknown>)['window'];
      let loggedError = '';
      console.error = (msg: string) => {
        loggedError = msg;
      };
      try {
        (globalThis as Record<string, unknown>)['window'] = failingWindow;
        initFn({
          local: seed.local,
          targetOrigin: 'http://localhost:3000',
        });
      } finally {
        console.error = origConsoleError;
        (globalThis as Record<string, unknown>)['window'] = origGlobalWin;
      }

      // Simulate the browser console message reaching page.onConsole
      getConsoleHandler()?.(loggedError);

      expect(() => result?.checkError?.()).toThrow(
        /Storage seeding failed: localStorage write failed: QuotaExceededError/,
      );
      // Ensure secret value is NEVER in the error
      expect(() => result?.checkError?.()).not.toThrow(/secret-val/);
    });

    it('fails when cookies are requested but context.addCookies is missing', async () => {
      const { fakePage } = makeFakes();
      const bareContext: PooledContext = {
        newPage: () => Promise.reject(new Error('not implemented')),
        close: () => Promise.resolve(),
      };

      await expect(
        seedStorageInto(bareContext, fakePage, 'http://localhost:3000/', {
          cookies: { token: 'val' },
        }),
      ).rejects.toThrow(/browser context does not support cookie seeding/);
    });

    it('fails when local storage is requested but page.addInitScript is missing', async () => {
      const { fakeContext } = makeFakes();
      const barePage: PooledPage = {
        goto: () => Promise.resolve(),
        close: () => Promise.resolve(),
        onCrash: () => {},
      };

      await expect(
        seedStorageInto(fakeContext, barePage, 'http://localhost:3000/', {
          local: { token: 'val' },
        }),
      ).rejects.toThrow(/page does not support storage seeding via init script/);
    });

    it('fails when page.addInitScript returns a non-disposable handle', async () => {
      const { fakeContext } = makeFakes();
      const nonDisposablePage: PooledPage = {
        goto: () => Promise.resolve(),
        close: () => Promise.resolve(),
        onCrash: () => {},
        // Returns void/undefined instead of a disposable handle
        addInitScript: () => Promise.resolve(undefined as never),
      };

      await expect(
        seedStorageInto(fakeContext, nonDisposablePage, 'http://localhost:3000/', {
          local: { token: 'val' },
        }),
      ).rejects.toThrow(/init script disposal is not supported by page/);
    });

    it('succeeds cleanly without capabilities when seedStorage is empty ({})', async () => {
      const bareContext: PooledContext = {
        newPage: () => Promise.reject(new Error('not implemented')),
        close: () => Promise.resolve(),
      };
      const barePage: PooledPage = {
        goto: () => Promise.resolve(),
        close: () => Promise.resolve(),
        onCrash: () => {},
      };

      await expect(
        seedStorageInto(bareContext, barePage, 'http://localhost:3000/', {}),
      ).resolves.not.toThrow();
    });
  });
});

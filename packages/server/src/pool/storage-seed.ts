import type { SeedStorage } from '@reticlehq/core';
import type { InitScriptHandle, PooledContext, PooledCookie, PooledPage } from './browser-pool.js';

export function targetOriginOf(navUrl: string): string | undefined {
  try {
    const origin = new URL(navUrl).origin;
    return origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeCookies(cookies: SeedStorage['cookies'], navUrl: string): PooledCookie[] {
  if (cookies === undefined) return [];
  let baseUrl: string | undefined;
  try {
    const u = new URL(navUrl);
    baseUrl = `${u.protocol}//${u.host}/`;
  } catch {
    baseUrl = undefined;
  }

  const out: PooledCookie[] = [];
  if (Array.isArray(cookies)) {
    for (const c of cookies) {
      const cookieObj: PooledCookie = {
        name: c.name,
        value: c.value,
      };
      if (c.domain !== undefined) cookieObj.domain = c.domain;
      if (c.path !== undefined) {
        cookieObj.path = c.path;
      } else if (c.domain !== undefined && c.url === undefined) {
        cookieObj.path = '/';
      }
      if (c.url !== undefined) {
        cookieObj.url = c.url;
      } else if (c.domain === undefined && baseUrl !== undefined) {
        cookieObj.url = baseUrl;
      }
      if (c.httpOnly !== undefined) cookieObj.httpOnly = c.httpOnly;
      if (c.secure !== undefined) cookieObj.secure = c.secure;
      if (c.sameSite !== undefined) cookieObj.sameSite = c.sameSite;
      if (c.expires !== undefined) cookieObj.expires = c.expires;
      out.push(cookieObj);
    }
  } else if ('object' === typeof cookies && null !== cookies) {
    for (const [name, value] of Object.entries(cookies)) {
      const cookieObj: PooledCookie = {
        name,
        value,
      };
      if (baseUrl !== undefined) {
        cookieObj.url = baseUrl;
      } else {
        cookieObj.path = '/';
      }
      out.push(cookieObj);
    }
  }
  return out;
}

export interface StorageSeedResult {
  handle?: InitScriptHandle;
  checkError?: () => void;
}

/**
 * Seed initial storage state (cookies, localStorage, sessionStorage) into a leased context and page
 * before the first navigation happens.
 *
 * Cookies are injected into the BrowserContext cookie jar so the initial HTTP GET to the target URL
 * already carries the Cookie header (including httpOnly session cookies).
 *
 * Local and session storage are injected via an init script evaluated after document creation but
 * before any inline or bundled application scripts run. The init script is scoped strictly to the
 * top-level target origin document (not child iframes or external redirect origins).
 *
 * Returns a handle that allows the caller to dispose of the init script once the initial navigation
 * has resolved, ensuring one-time semantics (reloads or future navigations do not reapply the seed).
 */
export async function seedStorageInto(
  context: PooledContext,
  page: PooledPage,
  targetUrl: string,
  seed: SeedStorage,
): Promise<StorageSeedResult | void> {
  const hasCookies =
    seed.cookies !== undefined &&
    (Array.isArray(seed.cookies) ? seed.cookies.length > 0 : Object.keys(seed.cookies).length > 0);
  const hasLocal = seed.local !== undefined && Object.keys(seed.local).length > 0;
  const hasSession = seed.session !== undefined && Object.keys(seed.session).length > 0;

  if (hasCookies && context.addCookies === undefined) {
    throw new Error('Storage seeding failed: browser context does not support cookie seeding');
  }
  if ((hasLocal || hasSession) && page.addInitScript === undefined) {
    throw new Error(
      'Storage seeding failed: page does not support storage seeding via init script',
    );
  }

  if (hasCookies && context.addCookies !== undefined) {
    const cookiesToSet = normalizeCookies(seed.cookies, targetUrl);
    if (cookiesToSet.length > 0) {
      await context.addCookies(cookiesToSet);
    }
  }

  let handle: InitScriptHandle | undefined;
  let capturedError: string | undefined;

  if (hasLocal || hasSession) {
    page.onConsole?.((text) => {
      if (text.startsWith('__reticle_seed_error:')) {
        capturedError = text.slice('__reticle_seed_error:'.length);
      }
    });

    const targetOrigin = targetOriginOf(targetUrl);
    const added = await page.addInitScript?.(
      ({
        local,
        session,
        targetOrigin,
      }: {
        local?: Record<string, string> | undefined;
        session?: Record<string, string> | undefined;
        targetOrigin?: string | undefined;
      }) => {
        const win = ((globalThis as unknown as { window?: unknown }).window ??
          globalThis) as unknown as {
          top?: unknown;
          location?: { origin?: string };
          localStorage?: { setItem(k: string, v: string): void };
          sessionStorage?: { setItem(k: string, v: string): void };
        };

        // Only seed the top-level document frame
        if (win.top !== win) return;

        // Only seed when the page is at the intended target origin
        if (undefined !== targetOrigin && win.location?.origin !== targetOrigin) return;

        let seedError: string | undefined;

        if (undefined !== local) {
          try {
            const storage = win.localStorage;
            if (!storage) {
              seedError = 'localStorage is not available';
            } else {
              for (const [k, v] of Object.entries(local)) {
                storage.setItem(k, v);
              }
            }
          } catch (err: unknown) {
            let errName = 'write error';
            if (null !== err && 'object' === typeof err && 'name' in err) {
              const name = (err as { name?: unknown }).name;
              if ('string' === typeof name) {
                errName = name;
              }
            }
            seedError = `localStorage write failed: ${errName}`;
          }
        }

        if (undefined === seedError && undefined !== session) {
          try {
            const storage = win.sessionStorage;
            if (!storage) {
              seedError = 'sessionStorage is not available';
            } else {
              for (const [k, v] of Object.entries(session)) {
                storage.setItem(k, v);
              }
            }
          } catch (err: unknown) {
            let errName = 'write error';
            if (null !== err && 'object' === typeof err && 'name' in err) {
              const name = (err as { name?: unknown }).name;
              if ('string' === typeof name) {
                errName = name;
              }
            }
            seedError = `sessionStorage write failed: ${errName}`;
          }
        }

        if (undefined !== seedError) {
          console.error(`__reticle_seed_error:${seedError}`);
        }
      },
      { local: seed.local, session: seed.session, targetOrigin },
    );

    if (undefined === added || 'function' !== typeof added.dispose) {
      throw new Error('Storage seeding failed: init script disposal is not supported by page');
    }
    handle = added;
  }

  const checkError = () => {
    if (capturedError !== undefined) {
      throw new Error(`Storage seeding failed: ${capturedError}`);
    }
  };

  return {
    ...(handle !== undefined ? { handle } : {}),
    checkError,
  };
}

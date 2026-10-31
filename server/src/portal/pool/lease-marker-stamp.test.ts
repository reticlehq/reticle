/**
 * #1352: a server redirect drops `?__reticle_session=` before the SDK loads, so the leased tab
 * registered under its own id and the lease named no session. The pool now stamps the marker back on
 * the document inside the leased page, before the SDK reads it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RETICLE_SESSION_STORAGE_KEY, RETICLE_URL_PARAM } from '@reticlehq/core';
import { BrowserPool } from './browser-pool.js';
import type { PooledBrowser, PooledPage } from './pool-contract.js';
import { installLeaseMarker, stampLeaseMarker } from './lease-marker-stamp.js';
import { queueEarlyConsole } from './lease-page-error.js';
import { resolveLeasedSessionId } from '../../surface/tools/lease-tools.js';

const SESSION = RETICLE_URL_PARAM.SESSION;
const ORIGIN = 'http://localhost:3000';

/** A document the init script can run in: location + history.replaceState, like a real window. */
function fakeDocument(
  href: string,
  framed = false,
  stored = new Map<string, string>(),
): { href: () => string; stored: Map<string, string> } {
  const win: Record<string, unknown> = {};
  win['sessionStorage'] = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => {
      stored.set(k, v);
    },
  };
  const loc = new URL(href);
  win['location'] = {
    get href() {
      return loc.toString();
    },
    origin: loc.origin,
  };
  win['history'] = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      loc.href = url;
    },
  };
  win['top'] = framed ? {} : win;
  (globalThis as unknown as { window: unknown }).window = win;
  return { href: () => loc.toString(), stored };
}

const arg = (session: string, targetOrigin = ORIGIN) => ({
  session,
  targetOrigin,
  sessionParam: SESSION,
  projectParam: RETICLE_URL_PARAM.PROJECT,
  sessionStorageKey: RETICLE_SESSION_STORAGE_KEY,
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** What the SDK does on connect: read the session from location.search, else mint its own id. */
const sdkRegistersAs = (href: string): string =>
  new URL(href).searchParams.get(SESSION) ?? 'tab-own-id';

describe('the lease marker survives a server redirect', () => {
  it('a redirect that dropped the marker: the SDK registers under the lease id and the lease resolves ready', () => {
    const doc = fakeDocument(`${ORIGIN}/login`); // /private 302 -> /login, query gone
    stampLeaseMarker(arg('lease-a'));
    const registered = sdkRegistersAs(doc.href());
    expect(registered).toBe('lease-a');
    const rows = [{ id: registered, url: doc.href() }];
    const store = { get: (id: string) => rows.find((r) => r.id === id), all: () => rows };
    expect(resolveLeasedSessionId(store, 'lease-a')).toBe('lease-a');
  });

  it('leaves a URL that already has the marker alone', () => {
    const doc = fakeDocument(`${ORIGIN}/x?${SESSION}=lease-a`);
    stampLeaseMarker(arg('lease-a'));
    expect(doc.href()).toBe(`${ORIGIN}/x?${SESSION}=lease-a`);
  });

  it('does not write the lease id into another origin (an identity provider) or a child frame', () => {
    const idp = fakeDocument('https://idp.example.com/sso');
    stampLeaseMarker(arg('lease-a'));
    expect(idp.href()).toBe('https://idp.example.com/sso');
    const framed = fakeDocument(`${ORIGIN}/embed`, true);
    stampLeaseMarker(arg('lease-a'));
    expect(framed.href()).toBe(`${ORIGIN}/embed`);
  });

  it('two concurrent leases on one origin never cross', () => {
    const a = fakeDocument(`${ORIGIN}/login`);
    stampLeaseMarker(arg('lease-a'));
    const b = fakeDocument(`${ORIGIN}/login`);
    stampLeaseMarker(arg('lease-b'));
    const rows = [
      { id: sdkRegistersAs(a.href()), url: a.href() },
      { id: sdkRegistersAs(b.href()), url: b.href() },
    ];
    const store = { get: (id: string) => rows.find((r) => r.id === id), all: () => rows };
    expect(resolveLeasedSessionId(store, 'lease-a')).toBe('lease-a');
    expect(resolveLeasedSessionId(store, 'lease-b')).toBe('lease-b');
  });

  it("a person's tab at the same URL is never adopted", () => {
    // Their tab is in their own browser, so the init script never ran there: no marker, own id.
    const rows = [{ id: 'person-tab', url: `${ORIGIN}/login` }];
    const store = { get: (id: string) => rows.find((r) => r.id === id), all: () => rows };
    expect(resolveLeasedSessionId(store, 'lease-a')).toBeUndefined();
  });
});

/**
 * #2026: an SPA that calls `history.replaceState` on load drops the query after the init script ran
 * and before the SDK connects. The SDK falls back to the tab's session store, so the init script
 * writes the lease id there too.
 */
describe('the lease id is in the tab session store before page scripts run', () => {
  it('writes the lease id in the top frame on the target origin', () => {
    const doc = fakeDocument(`${ORIGIN}/`);
    stampLeaseMarker(arg('lease-a'));
    expect(doc.stored.get(RETICLE_SESSION_STORAGE_KEY)).toBe('lease-a');
  });

  it('writes it also when the URL already has the marker', () => {
    const doc = fakeDocument(`${ORIGIN}/x?${SESSION}=lease-a`);
    stampLeaseMarker(arg('lease-a'));
    expect(doc.stored.get(RETICLE_SESSION_STORAGE_KEY)).toBe('lease-a');
  });

  it('does not write in a sub-frame or on another origin', () => {
    const framed = fakeDocument(`${ORIGIN}/embed`, true);
    stampLeaseMarker(arg('lease-a'));
    expect(framed.stored.size).toBe(0);
    const idp = fakeDocument('https://idp.example.com/sso');
    stampLeaseMarker(arg('lease-a'));
    expect(idp.stored.size).toBe(0);
  });

  it('keeps a value the tab already holds', () => {
    // A reload in the lease tab holds the lease id already. A different value is one the SDK wrote
    // for an explicit `connect({ session })`, and the init script must not replace it.
    const held = new Map([[RETICLE_SESSION_STORAGE_KEY, 'app-chosen']]);
    fakeDocument(`${ORIGIN}/`, false, held);
    stampLeaseMarker(arg('lease-a'));
    expect(held.get(RETICLE_SESSION_STORAGE_KEY)).toBe('app-chosen');
  });

  it('the pool passes the storage key to the init script', async () => {
    scriptsSeen.length = 0;
    const page: PooledPage = {
      goto: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
      onCrash: () => undefined,
      addInitScript: (_s: unknown, a?: unknown) => {
        scriptsSeen.push(a);
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
    };
    await installLeaseMarker(page, 'lease-a', ORIGIN, undefined);
    expect((scriptsSeen[0] as { sessionStorageKey: string }).sessionStorageKey).toBe(
      RETICLE_SESSION_STORAGE_KEY,
    );
  });
});

const scriptsSeen: unknown[] = [];

describe('the pool installs the stamp on the leased page only', () => {
  const scripts: Array<{ page: number; arg: unknown }> = [];
  function pool(): BrowserPool {
    let n = 0;
    const browser: PooledBrowser = {
      newContext: () =>
        Promise.resolve({
          newPage: () => {
            const id = n++;
            const page: PooledPage = {
              goto: () => Promise.resolve(undefined),
              close: () => Promise.resolve(),
              onCrash: () => undefined,
              addInitScript: (s: unknown, a?: unknown) => {
                // Every page gets the early console queue; this test is about the marker.
                if (s !== queueEarlyConsole) {
                  scripts.push({ page: id, arg: a });
                }
                return Promise.resolve({ dispose: () => Promise.resolve() });
              },
            };
            return Promise.resolve(page);
          },
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
      isConnected: () => true,
      onDisconnected: () => undefined,
    };
    return new BrowserPool(() => Promise.resolve(browser), {
      maxContexts: 4,
      genSessionId: () => 'x',
    });
  }

  it('each concurrent lease stamps its own id, scoped to its target origin', async () => {
    scripts.length = 0;
    const p = pool();
    const url = (id: string) => `${ORIGIN}/private?${SESSION}=${id}`;
    await Promise.all([
      p.acquire(url('lease-a'), { sessionId: 'lease-a' }),
      p.acquire(url('lease-b'), { sessionId: 'lease-b' }),
    ]);
    const ids = scripts.map((s) => (s.arg as { session: string }).session).sort();
    expect(ids).toEqual(['lease-a', 'lease-b']);
    expect(scripts.every((s) => (s.arg as { targetOrigin: string }).targetOrigin === ORIGIN)).toBe(
      true,
    );
    expect(new Set(scripts.map((s) => s.page)).size).toBe(2);
    await p.shutdown();
  });

  it('installs nothing when the URL carries no marker for this lease', async () => {
    scripts.length = 0;
    const p = pool();
    await p.acquire(`${ORIGIN}/plain`, { sessionId: 'lease-c' });
    expect(scripts).toEqual([]);
    await p.shutdown();
  });
});

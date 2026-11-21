import { describe, expect, it } from 'vitest';
import { DriveErrorCode, InputMode, RETICLE_SESSION_STORAGE_KEY } from '@reticlehq/core';
import { DriveError, LaunchedRealInputProvider, boxCenter, type ElementBox } from './real-input.js';
import { queueEarlyConsole } from '@/portal/pool/lease-page-error.js';

const DRIVE_URL = 'http://localhost:3000/app';
const SOURCE_BOX: ElementBox = { x: 0, y: 0, width: 200, height: 100 };
const TARGET_BOX: ElementBox = { x: 400, y: 200, width: 40, height: 20 };
/** Playwright's own wording when a handle outlives the page it points at. */
const CLOSED_MESSAGE = 'Target page, context or browser has been closed';

interface MouseCall {
  kind: string;
  x?: number;
  y?: number;
}

interface FakePageState {
  url: string;
  gotoCalls: string[];
  mouse: MouseCall[];
  evalCalls: string[];
  waitForFunctionCalls: number;
  gotoThrows?: boolean;
  waitForFunctionThrows?: boolean;
  viewport?: { width: number; height: number };
  routes?: string[];
  /** Scripts the provider asked to run on every later document of the page. */
  initScripts?: string[];
  /** The human closed the window, or Chromium died. Playwright keeps answering `url()` either way. */
  closed?: boolean;
  /** What `page.evaluate(script, value)` answers. Null when absent. */
  evaluates?: (script: unknown, value: unknown) => unknown;
}

function fakePage(state: FakePageState): unknown {
  return {
    url: () => state.url,
    isClosed: () => true === state.closed,
    setViewportSize: (size: { width: number; height: number }) => {
      if (true === state.closed) return Promise.reject(new Error(CLOSED_MESSAGE));
      state.viewport = size;
      return Promise.resolve();
    },
    route: (pattern: unknown) => {
      if (true === state.closed) return Promise.reject(new Error(CLOSED_MESSAGE));
      state.routes = [...(state.routes ?? []), String(pattern)];
      return Promise.resolve();
    },
    unroute: () => Promise.resolve(),
    goto: (url: string) => {
      state.gotoCalls.push(url);
      if (true === state.gotoThrows) return Promise.reject(new Error('goto boom'));
      state.url = url;
      return Promise.resolve(null);
    },
    waitForFunction: () => {
      state.waitForFunctionCalls += 1;
      if (true === state.waitForFunctionThrows) return Promise.reject(new Error('no SDK on page'));
      return Promise.resolve(null);
    },
    evaluate: (arg: unknown, value?: unknown) => {
      state.evalCalls.push(String(arg));
      return Promise.resolve(state.evaluates?.(arg, value) ?? null);
    },
    addInitScript: (script: unknown) => {
      // Every driven page gets the early console queue; these tests are about the reader.
      if (script === queueEarlyConsole) {
        return Promise.resolve();
      }
      state.initScripts = [...(state.initScripts ?? []), String(script)];
      return Promise.resolve();
    },
    mouse: {
      move: (x: number, y: number) => {
        state.mouse.push({ kind: 'move', x, y });
        return Promise.resolve();
      },
      click: (x: number, y: number) => {
        state.mouse.push({ kind: 'click', x, y });
        return Promise.resolve();
      },
      dblclick: (x: number, y: number) => {
        state.mouse.push({ kind: 'dblclick', x, y });
        return Promise.resolve();
      },
      down: () => {
        state.mouse.push({ kind: 'down' });
        return Promise.resolve();
      },
      up: () => {
        state.mouse.push({ kind: 'up' });
        return Promise.resolve();
      },
    },
    keyboard: {
      type: () => Promise.resolve(),
    },
  };
}

interface FakeBrowserState {
  closeCalls: number;
  page: FakePageState;
  newPageOpts?: unknown;
}

function fakeBrowser(state: FakeBrowserState): unknown {
  return {
    newPage: (opts?: unknown) => {
      state.newPageOpts = opts;
      return Promise.resolve(fakePage(state.page));
    },
    close: () => {
      state.closeCalls += 1;
      return Promise.resolve();
    },
  };
}

interface LaunchSpy {
  calls: { headless: boolean }[];
  state: FakeBrowserState;
  mode?: 'missing' | 'launchFails';
}

function makeLaunch(spy: LaunchSpy) {
  return (headless: boolean) => {
    spy.calls.push({ headless });
    if ('missing' === spy.mode) {
      return Promise.reject(new DriveError(DriveErrorCode.PLAYWRIGHT_MISSING, 'no playwright'));
    }
    if ('launchFails' === spy.mode) {
      return Promise.reject(new DriveError(DriveErrorCode.LAUNCH_FAILED, 'chromium crashed'));
    }
    return Promise.resolve(fakeBrowser(spy.state) as never);
  };
}

function newSpy(overrides: Partial<LaunchSpy> = {}): LaunchSpy {
  return {
    calls: [],
    state: {
      closeCalls: 0,
      page: {
        url: DRIVE_URL,
        gotoCalls: [],
        mouse: [],
        evalCalls: [],
        waitForFunctionCalls: 0,
        routes: [],
      },
    },
    ...overrides,
  };
}

function makeProvider(
  spy: LaunchSpy,
  opts: {
    headless?: boolean;
    injectConnect?: { token: string; url: string };
    storageState?: string;
    zeroInstallScript?: () => string | undefined;
  } = {},
): LaunchedRealInputProvider {
  return new LaunchedRealInputProvider({
    driveUrl: DRIVE_URL,
    headless: opts.headless ?? true,
    launch: makeLaunch(spy),
    sleep: () => Promise.resolve(),
    ...(opts.injectConnect !== undefined ? { injectConnect: opts.injectConnect } : {}),
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
    ...(opts.zeroInstallScript !== undefined ? { zeroInstallScript: opts.zeroInstallScript } : {}),
  });
}

describe('LaunchedRealInputProvider', () => {
  it('launches chromium headless and navigates to driveUrl', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    expect(spy.calls).toEqual([{ headless: true }]);
    // Stamped with `__reticle_opened`, so the page can tell Reticle opened it. Without that the
    // first-run tour mounts over a driven page and its scrim — `pointer-events: auto`, on purpose —
    // swallowed every native click and hover the drive made. See drive-url-stamp.ts.
    expect(spy.state.page.gotoCalls).toEqual([`${DRIVE_URL}?__reticle_opened=1`]);
  });

  it('passes headless:false through to chromium.launch', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy, { headless: false });
    await provider.navigate();

    expect(spy.calls).toEqual([{ headless: false }]);
  });

  it('opens the page with storageState when provided (starts authenticated)', async () => {
    const spy = newSpy();
    await makeProvider(spy, { storageState: 'auth.json' }).navigate();
    expect(spy.state.newPageOpts).toEqual({
      viewport: { width: 1440, height: 900 },
      storageState: 'auth.json',
    });
  });

  it('opens a headless page at the explicit default size when storageState is unset', async () => {
    const spy = newSpy();
    await makeProvider(spy).navigate();
    expect(spy.state.newPageOpts).toEqual({ viewport: { width: 1440, height: 900 } });
  });

  // Playwright's default is a fixed 1280x720 at pixel ratio 1, whatever the window is.
  it('opens a headed page with no viewport, so it takes the real window size', async () => {
    const spy = newSpy();
    await makeProvider(spy, { headless: false }).navigate();
    expect(spy.state.newPageOpts).toEqual({ viewport: null });
  });

  it('does not inject a connect when injectConnect is unset', async () => {
    const spy = newSpy();
    await makeProvider(spy).navigate();
    expect(spy.state.page.evalCalls).toEqual([]);
    expect(spy.state.page.waitForFunctionCalls).toBe(0);
  });

  it('re-invokes the page SDK connect with the token + allowNonLocalhost when injectConnect is set', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy, {
      injectConnect: { token: 'tok-123', url: 'ws://localhost:4400/reticle' },
    });
    await provider.navigate();

    expect(spy.state.page.waitForFunctionCalls).toBe(1);
    expect(spy.state.page.evalCalls).toHaveLength(1);
    const [script] = spy.state.page.evalCalls;
    expect(script).toContain('__reticleInstance.connect');
    expect(script).toContain('"allowNonLocalhost":true');
    expect(script).toContain('tok-123');
    expect(script).toContain('ws://localhost:4400/reticle');
  });

  it('navigate still succeeds when the page exposes no SDK (waitForFunction times out)', async () => {
    const spy = newSpy({
      state: {
        closeCalls: 0,
        page: {
          url: DRIVE_URL,
          gotoCalls: [],
          mouse: [],
          evalCalls: [],
          waitForFunctionCalls: 0,
          waitForFunctionThrows: true,
        },
      },
    });
    const provider = makeProvider(spy, {
      injectConnect: { token: 't', url: 'ws://localhost:4400/reticle' },
    });
    await expect(provider.navigate()).resolves.toBeUndefined();
    expect(spy.state.page.evalCalls).toEqual([]);
  });

  /*
   * `reticle verify <url>` with no daemon on the port, on an app with no Reticle SDK, answered
   * "No app connected": this provider opened the page and waited for an SDK that was not there.
   * A leased tab gets Reticle's own reader in that case, and so does this page now.
   */
  describe('a page with no Reticle SDK', () => {
    const READER = 'reader-script';
    const noSdk = (): LaunchSpy =>
      newSpy({
        state: {
          closeCalls: 0,
          page: {
            url: DRIVE_URL,
            gotoCalls: [],
            mouse: [],
            evalCalls: [],
            waitForFunctionCalls: 0,
            waitForFunctionThrows: true,
          },
        },
      });

    it('gets the zero-install reader, now and on every later document', async () => {
      const spy = noSdk();
      await makeProvider(spy, { zeroInstallScript: () => READER }).navigate();
      expect(spy.state.page.initScripts).toEqual([READER]);
      expect(spy.state.page.evalCalls).toEqual([READER]);
    });

    it('is left alone when the page loads its own SDK', async () => {
      const spy = newSpy();
      await makeProvider(spy, { zeroInstallScript: () => READER }).navigate();
      expect(spy.state.page.initScripts).toBeUndefined();
      expect(spy.state.page.evalCalls).toEqual([]);
    });

    it('is left alone when this install has no reader', async () => {
      const spy = noSdk();
      await makeProvider(spy, { zeroInstallScript: () => undefined }).navigate();
      expect(spy.state.page.initScripts).toBeUndefined();
      expect(spy.state.page.waitForFunctionCalls).toBe(0);
    });
  });

  it('isAvailableFor returns true for the launched page url', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    expect(await provider.isAvailableFor(DRIVE_URL)).toBe(true);
  });

  it('isAvailableFor matches when the page url drifted by fragment', async () => {
    const spy = newSpy({
      state: {
        closeCalls: 0,
        page: {
          url: `${DRIVE_URL}#section`,
          gotoCalls: [],
          mouse: [],
          evalCalls: [],
          waitForFunctionCalls: 0,
        },
      },
    });
    const provider = makeProvider(spy);
    await provider.navigate();

    expect(await provider.isAvailableFor(DRIVE_URL)).toBe(true);
  });

  it('isAvailableFor returns false for an unrelated url', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    expect(await provider.isAvailableFor('http://other.example/')).toBe(false);
  });

  it('perform hover moves the launched page mouse to the box center', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    const res = await provider.perform(DRIVE_URL, 'hover', SOURCE_BOX, {});
    const center = boxCenter(SOURCE_BOX);
    expect(res).toEqual({ performed: true, center, inputMode: InputMode.REAL });
    expect(spy.state.page.mouse.some((m) => 'move' === m.kind && m.x === center.cx)).toBe(true);
  });

  it('perform drag presses, interpolates, and releases on the launched page', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    const res = await provider.perform(DRIVE_URL, 'drag', SOURCE_BOX, { toBox: TARGET_BOX });
    expect(res.performed).toBe(true);
    const kinds = spy.state.page.mouse.map((m) => m.kind);
    expect(kinds).toContain('down');
    expect(kinds).toContain('up');
    const dst = boxCenter(TARGET_BOX);
    const lastMove = [...spy.state.page.mouse].reverse().find((m) => 'move' === m.kind);
    expect(lastMove?.x).toBeCloseTo(dst.cx);
    expect(lastMove?.y).toBeCloseTo(dst.cy);
  });

  it('construction surfaces a structured error when playwright is missing', async () => {
    const spy = newSpy({ mode: 'missing' });
    const provider = makeProvider(spy);
    await expect(provider.navigate()).rejects.toMatchObject({
      code: DriveErrorCode.PLAYWRIGHT_MISSING,
    });
  });

  it('navigate rejects with a launch error when chromium.launch throws', async () => {
    const spy = newSpy({ mode: 'launchFails' });
    const provider = makeProvider(spy);
    await expect(provider.navigate()).rejects.toMatchObject({
      code: DriveErrorCode.LAUNCH_FAILED,
    });
  });

  it('navigate rejects with a navigation error when goto throws', async () => {
    const spy = newSpy({
      state: {
        closeCalls: 0,
        page: {
          url: DRIVE_URL,
          gotoCalls: [],
          mouse: [],
          evalCalls: [],
          waitForFunctionCalls: 0,
          gotoThrows: true,
        },
      },
    });
    const provider = makeProvider(spy);
    await expect(provider.navigate()).rejects.toMatchObject({
      code: DriveErrorCode.NAVIGATE_FAILED,
    });
  });

  it('dispose closes the launched browser exactly once', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    await provider.dispose();
    await provider.dispose();

    expect(spy.state.closeCalls).toBe(1);
  });

  it('dispose is safe before navigate ran', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.dispose();

    expect(spy.state.closeCalls).toBe(0);
  });

  it('perform returns performed:false before navigate', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    const res = await provider.perform(DRIVE_URL, 'hover', SOURCE_BOX, {});
    expect(res.performed).toBe(false);
  });
});

/**
 * The capabilities `reticle drive` claims to unlock, and did not have.
 *
 * `reticle_viewport` and `reticle_network_mock` look for `setViewport` / `setMocks` on whatever
 * provider is attached. `CdpRealInputProvider` (attach to a browser someone else opened, via
 * RETICLE_CDP_URL) implements both; this provider — the one `reticle drive` and `reticle mcp
 * --drive` actually create — implemented neither, so both tools refused with `no-cdp-provider`
 * while a driven browser was sitting right there taking screenshots.
 *
 * The refusal then told the caller to "start with `reticle drive <url>`" — the exact thing they had
 * already done. An agent following that recommendation loops forever. Measured against a real
 * `reticle mcp --drive` process driving a real app.
 */
describe('the driven provider supports the tools that require a driven browser', () => {
  it('applies a viewport to the page it owns', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    const applied = await provider.setViewport?.(DRIVE_URL, { width: 1024, height: 768 });

    expect(applied).toBe(true);
    expect(spy.state.page.viewport).toEqual({ width: 1024, height: 768 });
  });

  it('installs network mocks on the page it owns', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    const applied = await provider.setMocks?.(DRIVE_URL, [
      { urlContains: '/api/thing', status: 503, body: '{}' },
    ]);

    expect(applied).toBe(true);
    expect((spy.state.page.routes ?? []).length).toBeGreaterThan(0);
  });

  it('refuses honestly before navigate, rather than pretending it applied', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);

    expect(await provider.setViewport?.(DRIVE_URL, { width: 800, height: 600 })).toBe(false);
    expect(await provider.setMocks?.(DRIVE_URL, [])).toBe(false);
  });

  /**
   * A page handle is cached for the life of the provider and Playwright keeps answering `url()`
   * after the page is gone, so a closed window read as available and every call threw
   * "Target page, context or browser has been closed" — reported from the field on a leased run.
   * A dead page is the same fact as no page: refuse, do not throw.
   */
  it('refuses instead of throwing once the page it owns has been closed', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    spy.state.page.closed = true;

    expect(await provider.isAvailableFor(DRIVE_URL)).toBe(false);
    expect(await provider.setViewport?.(DRIVE_URL, { width: 800, height: 600 })).toBe(false);
    expect(await provider.setMocks?.(DRIVE_URL, [])).toBe(false);
    expect((await provider.perform(DRIVE_URL, 'click', SOURCE_BOX, {})).performed).toBe(false);
    expect(await provider.screenshot(DRIVE_URL, {})).toBeUndefined();
  });
});

/*
 * #2060: a flow went to a page with no Reticle SDK, so the session dropped and did not come back.
 * The next flow then ran with no session. Between flows, `verify` reads the driven page: its URL,
 * its own session id, and whether it has the SDK. And it loads the start URL again in that page.
 * The facts that only Chromium can give (the id in sessionStorage, the SDK global) are proved in
 * the real browser by apps/e2e/specs/verify-session-lost-test.mjs.
 */
describe('the driven page between flows', () => {
  const DEAD_URL = 'http://localhost:3000/stats?id=missing';
  const STAMPED = `${DRIVE_URL}?__reticle_opened=1`;
  const TAB_ID = 's-driven-tab';

  it('is undefined before navigate ran', () => {
    expect(makeProvider(newSpy()).drivenPage()).toBeUndefined();
  });

  it('says the URL of the page it drives', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    spy.state.page.url = DEAD_URL;
    expect(provider.drivenPage()?.url()).toBe(DEAD_URL);
  });

  it("reads the page's own session id from the tab's session store", async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    spy.state.page.evaluates = (_script, key) =>
      key === RETICLE_SESSION_STORAGE_KEY ? TAB_ID : null;
    await expect(provider.drivenPage()?.sessionId()).resolves.toBe(TAB_ID);
    spy.state.page.evaluates = () => null;
    await expect(provider.drivenPage()?.sessionId()).resolves.toBeUndefined();
  });

  it('says if the SDK global is on the page now, and nothing when the page cannot be read', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    for (const answer of [true, false]) {
      spy.state.page.evaluates = () => answer;
      await expect(provider.drivenPage()?.hasSdk()).resolves.toBe(answer);
    }
    spy.state.page.evaluates = () => null;
    await expect(provider.drivenPage()?.hasSdk()).resolves.toBeUndefined();
  });

  // Review of #2261: "no SDK global yet" is not a dead end. A module script or a dynamic import
  // loads the SDK after the document has loaded. Only an HTTP error or another origin is.
  describe('a dead end', () => {
    const OWN = new URL(DRIVE_URL).origin;
    const facts = (over: Record<string, unknown>) => ({
      status: 200,
      origin: OWN,
      loaded: true,
      sdk: false,
      ...over,
    });
    const deadEnd = async (answer: unknown): Promise<boolean | undefined> => {
      const spy = newSpy();
      const provider = makeProvider(spy);
      await provider.navigate();
      spy.state.page.evaluates = () => answer;
      return provider.drivenPage()?.deadEnd();
    };

    // Final review of #2261: a Next.js not-found page loads the SDK in useEffect, with import(),
    // after hydration, which can be after `load`. Rule 14: such a page gets the start-page wait.
    it('is not a loaded page of the app with an HTTP error and no SDK yet', async () => {
      expect(await deadEnd(facts({ status: 404 }))).toBe(false);
    });

    it('is a loaded page on another origin with no SDK, as the browser error page', async () => {
      expect(await deadEnd(facts({ origin: 'https://example.com' }))).toBe(true);
      expect(await deadEnd(facts({ origin: 'null' }))).toBe(true);
    });

    it('is not a page of the app whose SDK has not loaded yet', async () => {
      expect(await deadEnd(facts({}))).toBe(false);
      expect(await deadEnd(facts({ loaded: false }))).toBe(false);
    });

    // An app's own error page (a Next not-found page, a Rails 422 page) can load the SDK late.
    it('is not an HTTP error page that is still loading, with no SDK yet', async () => {
      expect(await deadEnd(facts({ status: 404, loaded: false }))).toBe(false);
    });

    it('is not a page that has the SDK, whatever its status', async () => {
      expect(await deadEnd(facts({ status: 404, sdk: true }))).toBe(false);
    });

    it('is not a page on another origin that is still loading, as in a redirect', async () => {
      expect(await deadEnd(facts({ origin: 'https://idp.example.com', loaded: false }))).toBe(
        false,
      );
    });

    it('is not a page that cannot be read', async () => {
      expect(await deadEnd(null)).toBe(false);
    });
  });

  it('loads the start URL again in the same page', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    spy.state.page.url = DEAD_URL;
    await expect(provider.drivenPage()?.reopen()).resolves.toBe(true);
    expect(spy.calls).toHaveLength(1);
    expect(spy.state.page.gotoCalls).toEqual([STAMPED, STAMPED]);
  });

  // The reader is an init script, which runs on every later document. A second one each time the
  // page is opened again would pile up one copy for each lost session.
  it('does not add the zero-install reader again when it loads the start URL again', async () => {
    const spy = newSpy();
    spy.state.page.waitForFunctionThrows = true;
    const provider = makeProvider(spy, { zeroInstallScript: () => 'reader' });
    await provider.navigate();
    expect(spy.state.page.initScripts).toEqual(['reader']);
    await provider.drivenPage()?.reopen();
    await provider.drivenPage()?.reopen();
    expect(spy.state.page.initScripts).toEqual(['reader']);
  });

  it('connects a hosted preview again after it loads the start URL again', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy, { injectConnect: { token: 't', url: 'ws://127.0.0.1:1' } });
    await provider.navigate();
    const connects = (): number =>
      spy.state.page.evalCalls.filter((call) => call.includes('.connect(')).length;
    expect(connects()).toBe(1);
    await provider.drivenPage()?.reopen();
    expect(connects()).toBe(2);
  });

  it('is false, and does not throw, when the page cannot load', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();
    spy.state.page.gotoThrows = true;
    await expect(provider.drivenPage()?.reopen()).resolves.toBe(false);
  });
});

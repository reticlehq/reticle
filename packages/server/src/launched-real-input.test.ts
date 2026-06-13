import { describe, expect, it } from 'vitest';
import { DriveErrorCode } from '@syrin/protocol';
import { DriveError, LaunchedRealInputProvider, boxCenter, type ElementBox } from './real-input.js';

const DRIVE_URL = 'http://localhost:3000/app';
const SOURCE_BOX: ElementBox = { x: 0, y: 0, width: 200, height: 100 };
const TARGET_BOX: ElementBox = { x: 400, y: 200, width: 40, height: 20 };

interface MouseCall {
  kind: string;
  x?: number;
  y?: number;
}

interface FakePageState {
  url: string;
  gotoCalls: string[];
  mouse: MouseCall[];
  gotoThrows?: boolean;
}

function fakePage(state: FakePageState): unknown {
  return {
    url: () => state.url,
    goto: (url: string) => {
      state.gotoCalls.push(url);
      if (state.gotoThrows === true) return Promise.reject(new Error('goto boom'));
      state.url = url;
      return Promise.resolve(null);
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
}

function fakeBrowser(state: FakeBrowserState): unknown {
  return {
    newPage: () => Promise.resolve(fakePage(state.page)),
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
    if (spy.mode === 'missing') {
      return Promise.reject(new DriveError(DriveErrorCode.PLAYWRIGHT_MISSING, 'no playwright'));
    }
    if (spy.mode === 'launchFails') {
      return Promise.reject(new DriveError(DriveErrorCode.LAUNCH_FAILED, 'chromium crashed'));
    }
    return Promise.resolve(fakeBrowser(spy.state) as never);
  };
}

function newSpy(overrides: Partial<LaunchSpy> = {}): LaunchSpy {
  return {
    calls: [],
    state: { closeCalls: 0, page: { url: DRIVE_URL, gotoCalls: [], mouse: [] } },
    ...overrides,
  };
}

function makeProvider(
  spy: LaunchSpy,
  opts: { headless?: boolean } = {},
): LaunchedRealInputProvider {
  return new LaunchedRealInputProvider({
    driveUrl: DRIVE_URL,
    headless: opts.headless ?? true,
    launch: makeLaunch(spy),
    sleep: () => Promise.resolve(),
  });
}

describe('P2 LaunchedRealInputProvider', () => {
  it('launches chromium headless and navigates to driveUrl', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    expect(spy.calls).toEqual([{ headless: true }]);
    expect(spy.state.page.gotoCalls).toEqual([DRIVE_URL]);
  });

  it('passes headless:false through to chromium.launch', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy, { headless: false });
    await provider.navigate();

    expect(spy.calls).toEqual([{ headless: false }]);
  });

  it('isAvailableFor returns true for the launched page url', async () => {
    const spy = newSpy();
    const provider = makeProvider(spy);
    await provider.navigate();

    expect(await provider.isAvailableFor(DRIVE_URL)).toBe(true);
  });

  it('isAvailableFor matches when the page url drifted by fragment', async () => {
    const spy = newSpy({
      state: { closeCalls: 0, page: { url: `${DRIVE_URL}#section`, gotoCalls: [], mouse: [] } },
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
    expect(res).toEqual({ performed: true, center });
    expect(spy.state.page.mouse.some((m) => m.kind === 'move' && m.x === center.cx)).toBe(true);
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
    const lastMove = [...spy.state.page.mouse].reverse().find((m) => m.kind === 'move');
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
        page: { url: DRIVE_URL, gotoCalls: [], mouse: [], gotoThrows: true },
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

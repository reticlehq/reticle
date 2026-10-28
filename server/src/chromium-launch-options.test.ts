import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_ANTI_THROTTLING_ARGS,
  HEADED_WINDOW_ARGS,
  HEADLESS_VIEWPORT,
  chromiumLaunchOptions,
  pageViewportOptions,
} from './chromium-launch-options.js';

describe('chromiumLaunchOptions', () => {
  it('carries the anti-throttling switches next to the headless flag', () => {
    const opts = chromiumLaunchOptions(true);
    expect(opts.headless).toBe(true);
    for (const flag of CHROMIUM_ANTI_THROTTLING_ARGS) {
      expect(opts.args).toContain(flag);
    }
  });

  it('passes headless:false through untouched', () => {
    expect(chromiumLaunchOptions(false).headless).toBe(false);
  });

  it('carries an executable path when one is given, and none otherwise', () => {
    expect(chromiumLaunchOptions(true, undefined, '/opt/chromium/chrome')).toMatchObject({
      executablePath: '/opt/chromium/chrome',
    });
    expect(chromiumLaunchOptions(true)).not.toHaveProperty('executablePath');
  });

  it('hands out a fresh array each call, so a caller cannot mutate the constant', () => {
    const a = chromiumLaunchOptions(true);
    const b = chromiumLaunchOptions(true);
    expect(a.args).not.toBe(b.args);
    a.args.push('--sneaky');
    expect(b.args).not.toContain('--sneaky');
  });
});

// Without a viewport, Playwright gave every page a fixed 1280x720 at pixel ratio 1. A headed page
// then rendered small and soft on a Retina screen, and a bigger window changed nothing.
describe('pageViewportOptions', () => {
  it('gives a headless page the explicit default size', () => {
    expect(pageViewportOptions(true)).toEqual({ viewport: { width: 1440, height: 900 } });
    expect(HEADLESS_VIEWPORT).toEqual({ width: 1440, height: 900 });
  });

  it('gives a headed page no viewport, so it takes the window size and the screen pixel ratio', () => {
    expect(pageViewportOptions(false)).toEqual({ viewport: null });
  });

  it('keeps a size that a lease asks for, headed or headless', () => {
    const asked = { width: 375, height: 812 };
    expect(pageViewportOptions(true, asked)).toEqual({ viewport: asked });
    expect(pageViewportOptions(false, asked)).toEqual({ viewport: asked });
  });

  it('hands out a fresh object, so a caller cannot change the default', () => {
    const a = pageViewportOptions(true);
    expect(a.viewport).not.toBe(HEADLESS_VIEWPORT);
  });
});

describe('the headed window', () => {
  it('opens at the size of the screen when headed, and adds nothing when headless', () => {
    for (const flag of HEADED_WINDOW_ARGS) {
      expect(chromiumLaunchOptions(false).args).toContain(flag);
      expect(chromiumLaunchOptions(true).args).not.toContain(flag);
    }
  });
});

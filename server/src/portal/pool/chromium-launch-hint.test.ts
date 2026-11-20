/**
 * The launch hint must name the fix that works.
 *
 * Reported from the field (3.10.7, Linux): a lease said "Chromium is not installed for Playwright.
 * Run: npx playwright install chromium" on a host where Chromium was installed and the system
 * libraries it needs (libnspr4, libnss3) were missing. That install does nothing for missing
 * libraries, so the agent ran it again and stayed stuck. When the browser itself starts and the
 * loader cannot find a library, the error says so, and it also names `browserType.launch`, which
 * matched the missing-browser hint.
 */
import { describe, expect, it } from 'vitest';
import { chromiumLaunchHint } from './playwright-launcher.js';

const LOADER_ERROR = [
  'browserType.launch: Target page, context or browser has been closed',
  'Browser logs:',
  '/home/u/.cache/ms-playwright/chromium_headless_shell-1248/chrome-linux/headless_shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory',
].join('\n');

describe('chromiumLaunchHint', () => {
  it('names missing system libraries when the loader cannot find one', () => {
    const hint = chromiumLaunchHint(LOADER_ERROR);
    expect(hint).toMatch(/missing shared-library dependencies/);
    expect(hint).not.toMatch(/not installed/);
  });

  it("names missing system libraries for Playwright's own host check", () => {
    const msg =
      'browserType.launch: \n╔══╗\n║ Host system is missing dependencies to run browsers. ║\n║ libnss3 ║';
    expect(chromiumLaunchHint(msg)).toMatch(/missing shared-library dependencies/);
  });

  it('still names a missing browser when the executable is not there', () => {
    const msg =
      "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/x/chrome";
    expect(chromiumLaunchHint(msg)).toMatch(/Chromium is not installed for Playwright/);
  });
});

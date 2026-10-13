import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';
import { HEADLESS_ENV, headlessByDefault } from './daemon-start-options.js';

// From the field: a person watched their agent drive the app through `mcp`, whose browser pool was
// always hidden, and saw nothing happen. Shown is now the default for every command.
describe('whether a browser Reticle opens is hidden by default', () => {
  it('is shown on a desktop', () => {
    expect(headlessByDefault({}, 'darwin')).toBe(false);
    expect(headlessByDefault({}, 'win32')).toBe(false);
    expect(headlessByDefault({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(headlessByDefault({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
  });

  it('is hidden in CI, under the test batteries, and on Linux with no display', () => {
    expect(headlessByDefault({ CI: 'true' }, 'darwin')).toBe(true);
    expect(headlessByDefault({ [HEADLESS_ENV]: '1' }, 'darwin')).toBe(true);
    expect(headlessByDefault({}, 'linux')).toBe(true);
  });

  it('reads an off-looking RETICLE_HEADLESS as off, so a person can opt back in', () => {
    for (const off of ['', '0', 'false']) {
      expect(headlessByDefault({ [HEADLESS_ENV]: off }, 'darwin')).toBe(false);
    }
  });

  it('decides serve, mcp, the daemon and bare reticle alike', () => {
    for (const argv of [['serve'], ['mcp'], ['_daemon'], []]) {
      expect(parseCliArgs(argv, 4400, false)).toMatchObject({ headless: false });
      expect(parseCliArgs(argv, 4400, true)).toMatchObject({ headless: true });
    }
    expect(parseCliArgs(['mcp', '--headless'], 4400, false)).toMatchObject({ headless: true });
    expect(parseCliArgs(['mcp', '--headed'], 4400, true)).toMatchObject({ headless: false });
  });
});

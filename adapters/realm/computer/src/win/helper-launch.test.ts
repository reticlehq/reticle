import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { helperLaunch } from './helper-launch.js';

// The realm ran only on macOS: every path to the helper was the Swift program.
describe('the helper for each operating system', () => {
  it('is the Swift program on macOS and the UI Automation script in PowerShell on Windows', () => {
    expect(helperLaunch('darwin', '/n')).toEqual({
      file: join('/n', 'mac', 'build', 'reticle-ax'),
      prefix: [],
    });
    const windows = helperLaunch('win32', '/n');
    expect(windows?.file).toBe('powershell.exe');
    expect(windows?.prefix.slice(-2)).toEqual(['-File', join('/n', 'win', 'reticle-uia.ps1')]);
    expect(windows?.prefix).toContain('Bypass');
  });

  it('is none on an operating system with no helper', () => {
    expect(helperLaunch('linux', '/n')).toBeUndefined();
  });
});

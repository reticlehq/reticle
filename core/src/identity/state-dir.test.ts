import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { resolveStateDir } from './state-dir.js';

/**
 * A state folder override that is relative was used against the working folder up to 3.7. A
 * Windows-style path such as `C:\...` is relative to a POSIX Node (WSL, a container), and there it
 * made a `C:` folder inside the app, with the pairing token under it. A setting that is not usable
 * must never stop the daemon: it gets a warning and a usable folder.
 */
describe('resolveStateDir', () => {
  const home = '/home/u/.reticle';
  const cwdPosix = { ...posix, resolve: (path: string) => posix.resolve('/work/app', path) };

  function capture(): { warn: (message: string) => void; warnings: string[] } {
    const warnings: string[] = [];
    return { warn: (message) => warnings.push(message), warnings };
  }

  it('uses the override when it is absolute, with no warning', () => {
    const { warn, warnings } = capture();
    expect(resolveStateDir('/srv/state', home, posix, warn)).toBe('/srv/state');
    expect(warnings).toEqual([]);
  });

  it('uses the fallback when there is no override', () => {
    const { warn, warnings } = capture();
    expect(resolveStateDir(undefined, home, posix, warn)).toBe(home);
    expect(resolveStateDir('', home, posix, warn)).toBe(home);
    expect(warnings).toEqual([]);
  });

  it('resolves a relative override against the working folder, and warns', () => {
    const { warn, warnings } = capture();
    expect(resolveStateDir('tok/.reticle', home, cwdPosix, warn)).toBe('/work/app/tok/.reticle');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/work/app/tok/.reticle');
  });

  it.each(['C:\\Users\\u\\.reticle', 'C:/Users/u/.reticle', 'C:x'])(
    'refuses the Windows-style path %s on POSIX, uses the fallback, and warns',
    (override) => {
      const { warn, warnings } = capture();
      expect(resolveStateDir(override, home, cwdPosix, warn)).toBe(home);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(override);
      expect(warnings[0]).toContain(home);
    },
  );

  it('uses a Windows path under Windows path rules', () => {
    const { warn, warnings } = capture();
    expect(resolveStateDir('C:\\state', 'C:\\Users\\u\\.reticle', win32, warn)).toBe('C:\\state');
    expect(warnings).toEqual([]);
  });

  it('refuses a fallback that is not absolute, such as a home folder Node cannot read', () => {
    const { warn } = capture();
    expect(() => resolveStateDir(undefined, 'C:\\Users\\u/.reticle', posix, warn)).toThrow(
      /C:\\Users/,
    );
  });
});

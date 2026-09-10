/**
 * The Chromium hint must be satisfiable by following it, and arguable when it is wrong.
 *
 * The reported failure was a loop: doctor says missing, the user runs the suggested command, the
 * command succeeds, doctor still says missing. That is what an unpinned `npx playwright install`
 * does when the daemon bundles a different playwright — a different browser revision lands, and the
 * check the user was trying to satisfy never looked at it.
 *
 * The same reporter came back with the half of it that pinning does not fix. Their browsers root
 * held five chromium builds and the line still read a bare `missing`, so the only readings available
 * were "the check is broken" and "none of these count", with nothing to tell them apart. Present
 * but the wrong revision is a DIFFERENT problem from nothing installed: one is one download away,
 * the other means the lookup is pointed somewhere else. A line that collapses them is unactionable
 * however correct its verdict.
 */

import { describe, expect, it } from 'vitest';
import {
  chromiumHint,
  chromiumInstallCommand,
  chromiumInstallDepsCommand,
  parseChromiumRevision,
  type ChromiumProbe,
} from './chromium-hint.js';

const PLAYWRIGHT_VERSION = '1.61.1';
const MAC_EXECUTABLE =
  '/Users/x/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const MAC_ROOT = '/Users/x/Library/Caches/ms-playwright';
const WINDOWS_EXECUTABLE =
  'C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win\\chrome.exe';
const WINDOWS_ROOT = 'C:\\Users\\x\\AppData\\Local\\ms-playwright';

describe('chromium install command', () => {
  it('pins to the playwright the daemon actually bundles', () => {
    expect(chromiumInstallCommand(PLAYWRIGHT_VERSION)).toBe(
      'npx playwright@1.61.1 install chromium',
    );
  });

  it('falls back to an unpinned command rather than none', () => {
    expect(chromiumInstallCommand(undefined)).toBe('npx playwright install chromium');
  });
});

describe('chromium install-deps command', () => {
  it('pins to the playwright the daemon actually bundles', () => {
    expect(chromiumInstallDepsCommand(PLAYWRIGHT_VERSION)).toBe(
      'npx playwright@1.61.1 install-deps chromium',
    );
  });

  it('falls back to an unpinned command rather than none', () => {
    expect(chromiumInstallDepsCommand(undefined)).toBe('npx playwright install-deps chromium');
  });
});

describe('reading the wanted revision off the resolved path', () => {
  it('splits a posix path into root and revision', () => {
    expect(parseChromiumRevision(MAC_EXECUTABLE)).toEqual({
      revision: 'chromium-1223',
      root: MAC_ROOT,
    });
  });

  // The report came from Windows, where the browsers root is `%LOCALAPPDATA%\ms-playwright` and every
  // separator is a backslash. A posix-only split would find no revision there and silently downgrade
  // the line back to the bare `missing` this whole change exists to stop printing.
  it('splits a windows path into root and revision', () => {
    expect(parseChromiumRevision(WINDOWS_EXECUTABLE)).toEqual({
      revision: 'chromium-1223',
      root: WINDOWS_ROOT,
    });
  });

  it('has no answer for a path with no revision in it', () => {
    expect(parseChromiumRevision('/usr/bin/chromium')).toBeNull();
  });
});

describe('chromium doctor line', () => {
  const installed: ChromiumProbe = {
    exists: true,
    executablePath: MAC_EXECUTABLE,
    playwrightVersion: PLAYWRIGHT_VERSION,
    wantedRevision: 'chromium-1223',
    browsersRoot: MAC_ROOT,
    installedRevisions: ['chromium-1223'],
  };

  it('names the revision it is happy with, so a later bump is legible', () => {
    expect(chromiumHint(installed)).toBe('✓ installed (chromium-1223)');
  });

  it('names the path it probed, so a wrong lookup is visible', () => {
    const line = chromiumHint({ ...installed, exists: false, installedRevisions: [] });
    expect(line).toContain(MAC_EXECUTABLE);
    expect(line).toContain('npx playwright@1.61.1 install chromium');
  });

  it('names the browsers root it searched, because that is what the env var moves', () => {
    expect(chromiumHint({ ...installed, exists: false, installedRevisions: [] })).toContain(
      MAC_ROOT,
    );
  });

  /**
   * The reported machine, exactly: five builds present, none of them the wanted one. Calling that
   * `missing` sent the reporter to install a sixth.
   */
  it('says mismatched, not missing, when other revisions are installed', () => {
    const line = chromiumHint({
      ...installed,
      exists: false,
      installedRevisions: ['chromium-1194', 'chromium-1208', 'chromium-1217', 'chromium-1228'],
    });
    expect(line).toContain('wrong revision');
    expect(line).not.toContain('missing');
    expect(line).toContain('chromium-1223');
    expect(line).toContain('chromium-1194');
    expect(line).toContain('npx playwright@1.61.1 install chromium');
  });

  it('distinguishes a missing browser from a missing playwright', () => {
    expect(chromiumHint({ exists: false })).toContain('playwright package is not installed');
  });
});

/**
 * The one verdict in this file that is still evidence-free.
 *
 * The header says it about the OTHER branch — "naming the path is what turns 'missing' from a
 * verdict into evidence" — and then the playwright-absent branch says a bare "the playwright package
 * is not installed" with nothing to check it against. A reporter on Windows installed that exact
 * playwright version in BOTH the frontend and the repo root, confirmed Chromium was in the npx
 * cache, and kept getting the same line.
 *
 * They were not wrong and the line was not lying. It means "not installed WHERE THIS PROCESS CAN
 * RESOLVE IT", and the daemon usually runs from npx or a global install, so it resolves from its own
 * location and not from the user's project. Without the search paths there is no way to see that —
 * the only reading left is that the check is broken, which is what the header calls the unbreakable
 * loop.
 */
describe('the playwright-absent verdict says where it looked', () => {
  it('names the resolution roots it searched', () => {
    const line = chromiumHint({ exists: false, searchedPaths: ['/opt/daemon/node_modules'] });
    expect(line).toContain('/opt/daemon/node_modules');
  });

  it('still names the command, and does not pretend a browser is the problem', () => {
    const line = chromiumHint({ exists: false, searchedPaths: ['/a/node_modules'] });
    expect(line).toContain('playwright package is not installed');
    expect(line, 'installing a browser cannot fix an absent playwright').not.toContain(
      'wrong revision',
    );
  });

  it('names at most two, so the line stays a sentence rather than an ancestor dump', () => {
    const line = chromiumHint({
      exists: false,
      searchedPaths: ['/one/node_modules', '/two/node_modules'],
    });
    expect(line).toContain('/one/node_modules');
    expect(line).toContain('/two/node_modules');
  });

  it('degrades to the old bare line when the roots could not be read', () => {
    // Never worse than before: a probe that cannot enumerate its own resolution paths still answers.
    expect(chromiumHint({ exists: false })).toContain('playwright package is not installed');
    expect(chromiumHint({ exists: false })).not.toContain('looked in');
  });
});

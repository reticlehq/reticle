import { describe, expect, it } from 'vitest';
import { decideOpen, openCommand, openInBrowser } from './cli-launch.js';

describe('decideOpen', () => {
  it('with no url + a connected tab → reuse it (do not spawn a duplicate)', () => {
    expect(decideOpen([{ url: 'http://localhost:4310/app' }], undefined)).toEqual({
      action: 'reuse',
      url: 'http://localhost:4310/app',
    });
  });

  it('with no url + nothing connected → ask for a url', () => {
    expect(decideOpen([], undefined)).toEqual({ action: 'need-url' });
  });

  it('with a url already open at exactly that url → reuse (idempotent, no pile-up)', () => {
    expect(
      decideOpen([{ url: 'http://localhost:4310/checkout' }], 'http://localhost:4310/checkout'),
    ).toEqual({ action: 'reuse', url: 'http://localhost:4310/checkout' });
  });

  /**
   * Reusing the tab is still right — the origin match is what stops `reticle open` piling up a tab
   * per run. Reporting it as `reusing` was not: `reticle open http://localhost:3000/settings` printed
   * that it had reused a tab, exited 0, and left the tab sitting on `/`. The caller reads a success
   * and goes on to assert against a page that was never opened.
   */
  it('with a url on the same origin but a DIFFERENT page → says the tab was left where it is', () => {
    expect(
      decideOpen([{ url: 'http://localhost:4310/dashboard' }], 'http://localhost:4310/checkout'),
    ).toEqual({
      action: 'left-as-is',
      url: 'http://localhost:4310/dashboard',
      requested: 'http://localhost:4310/checkout',
    });
  });

  it('with a url on a different origin → open it', () => {
    expect(decideOpen([{ url: 'http://localhost:4310/app' }], 'http://localhost:3000/')).toEqual({
      action: 'open',
      url: 'http://localhost:3000/',
    });
  });

  it('with a url + nothing connected → open it', () => {
    expect(decideOpen([], 'http://localhost:5173/')).toEqual({
      action: 'open',
      url: 'http://localhost:5173/',
    });
  });
});

describe('openCommand — per-platform OS open', () => {
  it('macOS uses `open`', () => {
    expect(openCommand('http://x', 'darwin')).toEqual({ cmd: 'open', args: ['http://x'] });
  });
  it('Windows uses `start`', () => {
    expect(openCommand('http://x', 'win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'http://x'],
    });
  });
  it('Linux uses `xdg-open`', () => {
    expect(openCommand('http://x', 'linux')).toEqual({ cmd: 'xdg-open', args: ['http://x'] });
  });
  it('Windows percent-encodes cmd metacharacters so a URL cannot break out of `start`', () => {
    const { args } = openCommand('http://x/?a=1&b=2^c|calc', 'win32');
    const encoded = args[3] ?? '';
    expect(encoded).toBe('http://x/?a=1%26b=2%5Ec%7Ccalc');
    for (const dangerous of ['&', '^', '|', '<', '>']) {
      expect(encoded.includes(dangerous)).toBe(false);
    }
  });
  it('Windows leaves existing percent-encoding intact (no double-encoding)', () => {
    expect(openCommand('http://x/?q=a%20b', 'win32').args[3]).toBe('http://x/?q=a%20b');
  });
});

describe('openInBrowser', () => {
  it('runs the platform command with the url (spawn injected, hermetic)', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const failure = await openInBrowser('http://localhost:4310', 'darwin', (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(null);
    });
    expect(calls).toEqual([{ cmd: 'open', args: ['http://localhost:4310'] }]);
    expect(failure).toBeNull();
  });

  /**
   * A launcher that could not run must be REPORTED, not swallowed.
   *
   * This returned void and the caller printed `{"opened": url}` regardless, so a machine where the
   * browser never opened produced output identical to one where it did. Reported from the field as
   * twenty minutes lost chasing a phantom port problem while nothing had ever been launched.
   */
  it('reports the reason when the launcher cannot be run at all', async () => {
    const failure = await openInBrowser('http://localhost:4310', 'linux', () =>
      Promise.resolve('spawn xdg-open ENOENT'),
    );
    expect(failure).toBe('spawn xdg-open ENOENT');
  });
});

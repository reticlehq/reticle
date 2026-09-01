import { describe, expect, it } from 'vitest';
import {
  decideOpen,
  openCommand,
  openInBrowser,
  resolveOpen,
  sessionAnswers,
} from './cli-launch.js';

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

  /**
   * Connected is not the same as answering. A hidden/throttled tab stays in /status while every
   * command against it times out, and ending the session does not recover it — the wedged thing is
   * the daemon's page. `reticle open` is the recovery command; it must not hand that page back.
   */
  it('does not reuse a tab that the probe said is not answering', () => {
    expect(
      decideOpen([{ url: 'http://localhost:4321/', alive: false }], 'http://localhost:4321/'),
    ).toEqual({
      action: 'open',
      url: 'http://localhost:4321/',
      replacing: 'http://localhost:4321/',
    });
  });

  it('does not leave-as-is a silent tab on the same origin — that is the same dead end', () => {
    expect(
      decideOpen([{ url: 'http://localhost:4321/issues', alive: false }], 'http://localhost:4321/'),
    ).toEqual({
      action: 'open',
      url: 'http://localhost:4321/',
      replacing: 'http://localhost:4321/issues',
    });
  });

  it('still reuses a live tab on the exact url, even when a silent one is listed first', () => {
    expect(
      decideOpen(
        [
          { url: 'http://localhost:4321/', alive: false },
          { url: 'http://localhost:4321/', alive: true },
        ],
        'http://localhost:4321/',
      ),
    ).toEqual({ action: 'reuse', url: 'http://localhost:4321/' });
  });

  it('with no url and only a silent tab → open that url rather than ask or reuse', () => {
    expect(decideOpen([{ url: 'http://localhost:4321/issues', alive: false }], undefined)).toEqual({
      action: 'open',
      url: 'http://localhost:4321/issues',
      replacing: 'http://localhost:4321/issues',
    });
  });

  it('treats a tab with no alive flag as live — that is the unprobed / older-daemon case', () => {
    expect(decideOpen([{ url: 'http://localhost:4310/app' }], 'http://localhost:4310/app')).toEqual(
      {
        action: 'reuse',
        url: 'http://localhost:4310/app',
      },
    );
  });
});

describe('sessionAnswers — fail open on an older daemon, fail closed on a proven silence', () => {
  it('treats a 404 as alive so an older daemon keeps the previous reuse behaviour', async () => {
    await expect(
      sessionAnswers(4400, 's1', () => Promise.resolve({ status: 404, body: 'not found' })),
    ).resolves.toBe(true);
  });

  it('treats {alive:false} as dead — that is the probe the new daemon answers', async () => {
    await expect(
      sessionAnswers(4400, 's1', () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({ alive: false }),
        }),
      ),
    ).resolves.toBe(false);
  });

  it('treats {alive:true} as live', async () => {
    await expect(
      sessionAnswers(4400, 's1', () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({ alive: true }),
        }),
      ),
    ).resolves.toBe(true);
  });

  it('fails open on a transport error, so a brief blip does not spawn a duplicate tab', async () => {
    await expect(
      sessionAnswers(4400, 's1', () => Promise.reject(new Error('ECONNREFUSED'))),
    ).resolves.toBe(true);
  });
});

describe('resolveOpen — probe only the tab that would be reused', () => {
  it('reuses a live tab after one probe, and does not probe a silent extra origin', async () => {
    const probed: string[] = [];
    const decision = await resolveOpen(
      [
        { sessionId: 'live', url: 'http://localhost:4321/' },
        { sessionId: 'other', url: 'http://localhost:3000/' },
      ],
      'http://localhost:4321/',
      (id) => {
        probed.push(id);
        return Promise.resolve('live' === id);
      },
    );
    expect(decision).toEqual({ action: 'reuse', url: 'http://localhost:4321/' });
    expect(probed).toEqual(['live']);
  });

  it('opens a fresh tab when the only candidate is silent, and names it as replacing', async () => {
    const decision = await resolveOpen(
      [{ sessionId: 'wedged', url: 'http://localhost:4321/' }],
      'http://localhost:4321/',
      () => Promise.resolve(false),
    );
    expect(decision).toEqual({
      action: 'open',
      url: 'http://localhost:4321/',
      replacing: 'http://localhost:4321/',
    });
  });

  it('skips a silent exact-url tab and reuses a later live one on the same url', async () => {
    const probed: string[] = [];
    const decision = await resolveOpen(
      [
        { sessionId: 'wedged', url: 'http://localhost:4321/' },
        { sessionId: 'live', url: 'http://localhost:4321/' },
      ],
      'http://localhost:4321/',
      (id) => {
        probed.push(id);
        return Promise.resolve('live' === id);
      },
    );
    expect(decision).toEqual({ action: 'reuse', url: 'http://localhost:4321/' });
    expect(probed).toEqual(['wedged', 'live']);
  });

  it('with no url and only a silent tab, opens that url instead of asking for one', async () => {
    const decision = await resolveOpen(
      [{ sessionId: 'wedged', url: 'http://localhost:4321/issues' }],
      undefined,
      () => Promise.resolve(false),
    );
    expect(decision).toEqual({
      action: 'open',
      url: 'http://localhost:4321/issues',
      replacing: 'http://localhost:4321/issues',
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

/**
 * `reticle open <url> --navigate` moves the tab already on that origin (#1140).
 *
 * The default leaves that tab where it is, which is right for a person's tab and a dead end for a
 * caller with no MCP tools: a CLI loop over a multi-page site could not get past the first page
 * without restarting the daemon. The flag is the explicit opt-in; without it nothing changes.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import type { ToolCaller } from './adhoc-verdict.js';
import { parseCliArgs } from './cli-parse.js';
import { decideOpen } from './launch/cli-launch.js';
import {
  NAVIGATE_NO_SESSION_ID,
  NAVIGATE_UNCONFIRMED_NOTE,
  navigateLeftTab,
  openCandidates,
} from './open-navigate.js';

function fakeDaemon(answer: Record<string, unknown>): {
  connect: (endpoint: URL) => Promise<ToolCaller>;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    connect: () =>
      Promise.resolve({
        call: (name, args) => {
          calls.push({ name, args });
          return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
        },
        close: () => Promise.resolve(),
      }),
  };
}

describe('reticle open --navigate', () => {
  it('parses as an opt-in, off by default', () => {
    expect(parseCliArgs(['open', 'http://localhost:3000/b', '--navigate'], 4400)).toMatchObject({
      kind: 'open',
      url: 'http://localhost:3000/b',
      navigate: true,
    });
    expect(parseCliArgs(['open', 'http://localhost:3000/b'], 4400)).toMatchObject({
      kind: 'open',
      navigate: false,
    });
  });

  it('names the tab it left, so --navigate moves that one', () => {
    expect(
      decideOpen([{ sessionId: 's-a', url: 'http://localhost:3000/a' }], 'http://localhost:3000/b'),
    ).toEqual({
      action: 'left-as-is',
      url: 'http://localhost:3000/a',
      requested: 'http://localhost:3000/b',
      sessionId: 's-a',
    });
  });

  it('sends reticle_navigate to that session and reports the arrival', async () => {
    const daemon = fakeDaemon({ ok: true, url: 'http://localhost:3000/b', confirmed: true });

    const out = await navigateLeftTab({
      port: 4400,
      sessionId: 's-a',
      url: 'http://localhost:3000/b',
      connect: daemon.connect,
    });

    expect(daemon.calls).toEqual([
      { name: ReticleTool.NAVIGATE, args: { url: 'http://localhost:3000/b', sessionId: 's-a' } },
    ]);
    expect(out).toEqual({ navigated: 'http://localhost:3000/b', sessionId: 's-a' });
  });

  it('does not call an unobserved arrival navigated', async () => {
    const daemon = fakeDaemon({ ok: true, confirmed: false });

    const out = await navigateLeftTab({
      port: 4400,
      sessionId: 's-a',
      url: 'http://localhost:3000/b',
      connect: daemon.connect,
    });

    expect(out['navigated']).toBeUndefined();
    expect(out['error']).toBeUndefined();
    expect(out).toMatchObject({
      requested: 'http://localhost:3000/b',
      note: NAVIGATE_UNCONFIRMED_NOTE,
    });
  });

  it('reports the session the page reconnected as, which is the one to act on next', async () => {
    const daemon = fakeDaemon({ ok: true, confirmed: true, sessionId: 's-b' });

    const out = await navigateLeftTab({
      port: 4400,
      sessionId: 's-a',
      url: 'http://localhost:3000/b',
      connect: daemon.connect,
    });

    expect(out).toEqual({ navigated: 'http://localhost:3000/b', sessionId: 's-b' });
  });

  it('passes on where a redirect landed', async () => {
    const daemon = fakeDaemon({ ok: true, landedOn: 'http://localhost:3000/login' });

    const out = await navigateLeftTab({
      port: 4400,
      sessionId: 's-a',
      url: 'http://localhost:3000/b',
      connect: daemon.connect,
    });

    expect(out).toMatchObject({
      navigated: 'http://localhost:3000/b',
      landedOn: 'http://localhost:3000/login',
    });
  });

  it('reports a failed navigate as an error, never as arrival', async () => {
    const daemon = fakeDaemon({ ok: false, reason: 'the page did not answer' });

    const out = await navigateLeftTab({
      port: 4400,
      sessionId: 's-a',
      url: 'http://localhost:3000/b',
      connect: daemon.connect,
    });

    expect(out['navigated']).toBeUndefined();
    expect(String(out['error'])).toContain('the page did not answer');
  });

  it('says so when the daemon cannot be reached', async () => {
    const out = await navigateLeftTab({
      port: 4400,
      sessionId: 's-a',
      url: 'http://localhost:3000/b',
      connect: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    expect(String(out['error'])).toContain('ECONNREFUSED');
  });
});

// `--navigate` moves a tab, so on a daemon serving two projects it may only pick one of this
// project's: the origin match alone would hand it a sibling project's tab on the same origin.
describe('the tabs open may pick from', () => {
  const tabs = [
    { url: 'http://localhost:3000/a', sessionId: 'mine', projectId: 'shop' },
    { url: 'http://localhost:3000/b', sessionId: 'theirs', projectId: 'admin' },
    { url: 'http://localhost:3000/c', sessionId: 'unknown' },
  ];

  it("with --navigate, keeps this project's tabs and tabs with no project, never a sibling's", () => {
    const picked = openCandidates(tabs, true, 'shop').map((t) => t.sessionId);
    expect(picked).toEqual(['mine', 'unknown']);
    // The decision made over them cannot land on the sibling's tab.
    const decision = decideOpen(
      openCandidates(
        tabs.filter((t) => 'theirs' === t.sessionId),
        true,
        'shop',
      ),
      'http://localhost:3000/x',
    );
    expect('sessionId' in decision ? decision.sessionId : undefined).not.toBe('theirs');
  });

  it('without --navigate, or with no project to scope by, keeps every tab', () => {
    expect(openCandidates(tabs, false, 'shop')).toHaveLength(3);
    expect(openCandidates(tabs, true, undefined)).toHaveLength(3);
  });
});

describe('when --navigate cannot move the tab', () => {
  it('says why instead of suggesting --navigate', () => {
    expect(NAVIGATE_NO_SESSION_ID).toContain('reported no session id');
    expect(NAVIGATE_NO_SESSION_ID).not.toMatch(/pass --navigate/i);
  });
});

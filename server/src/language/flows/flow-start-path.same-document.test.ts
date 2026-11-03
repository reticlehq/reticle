/**
 * A navigation to the page the tab is already on, on a hash-routed app, still loads the page.
 *
 * Field report on a hash-routed app: replay reset the start page by assigning its URL. The tab was
 * already on that URL (`/#/…`), and assigning a URL that differs only in its fragment, or not at
 * all, is a same-document jump: the browser loads no page, no new session connects, and every
 * replay stopped after 5 s with "no page was connected". `navigateAndAwait` waits for a page load,
 * so for a same-document URL with a fragment it now also asks the page to reload.
 */
import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult } from '@reticlehq/core';
import { navigateAndAwait } from './flow-start-path.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';

const ok: CommandResult = { kind: 'command_result', id: 'c', ok: true, result: { ok: true } };

async function commandsFor(current: string, destination: string): Promise<string[]> {
  const sent: string[] = [];
  const tab = {
    id: 'old',
    url: current,
    command: (name: string) => {
      sent.push(name);
      return Promise.resolve(ok);
    },
  };
  const fresh = { id: 'fresh', url: destination, eventsSince: () => [] };
  let look = 0;
  const sessions = {
    resolve: () => {
      look += 1;
      if (look < 2) {
        throw new Error('no connected session');
      }
      return fresh as unknown as Session;
    },
  } as unknown as SessionManager;
  let t = 0;
  const clock = {
    now: () => t,
    sleep: () => {
      t += 100;
      return Promise.resolve();
    },
  };
  const path = new URL(destination).hash.length > 0 ? new URL(destination).hash : '/';
  await navigateAndAwait(sessions, tab, destination, path, 1_000, clock, { isReload: true });
  return sent;
}

describe('a navigation that the browser would treat as a jump within the page', () => {
  it('reloads when the destination is the current URL with its fragment', async () => {
    expect(
      await commandsFor('http://localhost:5173/#/orders', 'http://localhost:5173/#/orders'),
    ).toEqual([ReticleCommand.NAVIGATE, ReticleCommand.REFRESH]);
  });

  it('reloads when only the fragment differs, as a hash router writes its route', async () => {
    expect(
      await commandsFor(
        'http://localhost:5173/index.html#/orders?tab=2',
        'http://localhost:5173/index.html#/orders',
      ),
    ).toEqual([ReticleCommand.NAVIGATE, ReticleCommand.REFRESH]);
  });

  it('does not reload a navigation to another path, which loads a page by itself', async () => {
    expect(
      await commandsFor('http://localhost:5173/#/orders', 'http://localhost:5173/settings#/a'),
    ).toEqual([ReticleCommand.NAVIGATE]);
  });

  it('does not reload the same URL with no fragment, which a browser already reloads', async () => {
    expect(
      await commandsFor('http://localhost:5173/orders', 'http://localhost:5173/orders'),
    ).toEqual([ReticleCommand.NAVIGATE]);
  });
});

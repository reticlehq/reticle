/**
 * A daemon that closes with a tab still open saves what that tab drove, and syncs it.
 *
 * Teardown — the only writer of a `drive-*` flow — ran from the socket's close handler, unawaited.
 * The daemon's own close flushed cloud sync FIRST and terminated the sockets after, so a flow an
 * agent proved with `act_and_wait` in a tab that was still open when the daemon stopped (`reticle
 * stop`, an upgrade restart) was written after the last sync, or not at all once the process exited.
 */
import { describe, expect, it } from 'vitest';
import { endLiveSessions } from './session-end.js';

interface Tab {
  readonly id: string;
}

function registry(tabs: Tab[]): { all: () => Tab[]; remove: (t: Tab) => boolean } {
  const live = new Set(tabs);
  return { all: () => [...live], remove: (t) => live.delete(t) };
}

describe('ending the live sessions on close', () => {
  it('runs every open tab teardown to completion before it resolves', async () => {
    const done: string[] = [];
    const tabs = registry([{ id: 'a' }, { id: 'b' }]);
    await endLiveSessions(tabs, async (t) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(t.id);
    });
    expect(done.sort()).toEqual(['a', 'b']);
  });

  it('takes each tab out of the registry first, so its socket closing later tears down nothing', async () => {
    const tab = { id: 'a' };
    const tabs = registry([tab]);
    await endLiveSessions(tabs, () => Promise.resolve());
    expect(tabs.remove(tab)).toBe(false);
  });

  it('a teardown that throws does not stop the others', async () => {
    const done: string[] = [];
    await endLiveSessions(registry([{ id: 'bad' }, { id: 'good' }]), (t) => {
      if ('bad' === t.id) return Promise.reject(new Error('disk full'));
      done.push(t.id);
      return Promise.resolve();
    });
    expect(done).toEqual(['good']);
  });
});

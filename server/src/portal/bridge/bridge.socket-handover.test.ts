import { describe, it, expect, afterEach } from 'vitest';
import { ReticleCommand } from '@reticlehq/core';
import { Bridge } from './bridge.js';
import { FakeBrowser, waitUntil } from './bridge.test-harness.js';
import type { Session } from '@/portal/session/session.js';

/**
 * #2302: after a Fast Refresh or a navigation, `match` timed out at 1500 ms while the page still
 * sent heartbeats. A reload or a navigation closes the old socket BEFORE the new one says hello, so
 * the bridge had nothing to replace. A caller that held the old handle sent into a closed socket.
 */
const SESSION_ID = 'same-tab';
const BUDGET_MS = 1500;

let bridge: Bridge | undefined;
const pages: FakeBrowser[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) {
    page.close();
  }
  await bridge?.close();
  bridge = undefined;
});

async function start(): Promise<{ live: Bridge; port: number }> {
  const live = new Bridge({ port: 0 });
  bridge = live;
  return { live, port: await live.ready };
}

async function openPage(port: number): Promise<FakeBrowser> {
  const page = new FakeBrowser(port, SESSION_ID);
  pages.push(page);
  await page.open();
  return page;
}

function current(live: Bridge): Session | undefined {
  return live.sessions.get(SESSION_ID);
}

describe('a command reaches the live socket of its session (#2302)', () => {
  it('answers on the second socket when the first closes after the second registers', async () => {
    const { live, port } = await start();
    const first = await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    const old = current(live);
    const second = await openPage(port);
    await waitUntil(() => current(live) !== old);
    first.close();

    const result = await live.sessions
      .resolve(SESSION_ID)
      .command(ReticleCommand.MATCH, { query: {} }, BUDGET_MS);

    expect(result.ok).toBe(true);
    expect(second.received.map((c) => c.name)).toEqual([ReticleCommand.MATCH]);
  });

  it('sends a held handle to the new socket when the old one closed before the new hello', async () => {
    const { live, port } = await start();
    const first = await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    const held = current(live);
    first.close();
    await waitUntil(() => current(live) === undefined);
    const second = await openPage(port);
    await waitUntil(() => current(live) !== undefined);

    const result = await held?.command(ReticleCommand.MATCH, { query: {} }, BUDGET_MS);

    expect(result?.ok).toBe(true);
    expect(second.received.map((c) => c.name)).toEqual([ReticleCommand.MATCH]);
  });

  it('follows two reloads in a row to the newest socket', async () => {
    const { live, port } = await start();
    const first = await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    const held = current(live);
    first.close();
    await waitUntil(() => current(live) === undefined);
    const second = await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    second.close();
    await waitUntil(() => current(live) === undefined);
    const third = await openPage(port);
    await waitUntil(() => current(live) !== undefined);

    const result = await held?.command(ReticleCommand.MATCH, { query: {} }, BUDGET_MS);

    expect(result?.ok).toBe(true);
    expect(third.received.map((c) => c.name)).toEqual([ReticleCommand.MATCH]);
  });

  it('does not hand a parked window to a later connection', async () => {
    const { live, port } = await start();
    await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    const held = current(live);
    if (held === undefined) {
      throw new Error('no session');
    }
    live.sessions.park(held);
    await waitUntil(() => current(live) === undefined);
    // A different tab under another id must not become the parked window's successor.
    const other = new FakeBrowser(port, 'other-tab');
    pages.push(other);
    await other.open();
    await waitUntil(() => live.sessions.get('other-tab') !== undefined);

    await expect(held.command(ReticleCommand.MATCH, { query: {} }, 300)).rejects.toThrow(
      /timed out/,
    );
    expect(other.received).toEqual([]);
  });

  it('moves a read sent while the page reloads to the socket that comes back', async () => {
    const { live, port } = await start();
    const first = await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    const held = current(live);
    first.close();
    await waitUntil(() => current(live) === undefined);

    // Sent in the gap: no socket is open for this id yet.
    const pending = held?.command(ReticleCommand.MATCH, { query: {} }, BUDGET_MS);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await openPage(port);

    const result = await pending;
    expect(result?.ok).toBe(true);
    expect(second.received.map((c) => c.name)).toEqual([ReticleCommand.MATCH]);
  });

  it('does not perform an act sent during the reload a second time on the new page', async () => {
    const { live, port } = await start();
    const first = await openPage(port);
    await waitUntil(() => current(live) !== undefined);
    const held = current(live);
    first.close();
    await waitUntil(() => current(live) === undefined);

    const pending = held?.command(ReticleCommand.ACT, { ref: 'e7', action: 'click' }, 10_000);
    const settled = pending?.then(
      () => 'answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const second = await openPage(port);

    // Rejected as replaced when the page comes back, not left to its 10 s budget.
    await expect(settled).resolves.toMatch(/replaced by a newer connection/);
    expect(second.received).toEqual([]);
  });
});

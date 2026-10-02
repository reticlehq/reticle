/**
 * The fix for "syncing is not happening", asserted as behaviour rather than as plumbing.
 *
 * The defect: a run artifact was written by session teardown and nowhere else, so every verdict
 * produced while a tab stayed open was invisible to the sync daemon — which can only push artifacts
 * that exist. The first test here is the one that fails without the fix.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { HookEvent, type HookPayload } from '@reticlehq/core/hooks';
import { emitHook, resetHooks } from '@/hooks/hook-bus.js';
import { attachDriveRunFlush } from './drive-run-flush.js';

afterEach(() => resetHooks());

const verdict = (sessionId?: string): HookPayload => ({
  event: HookEvent.VERDICT,
  at: '2026-01-01T00:00:00.000Z',
  tool: 'reticle_assert',
  verified: 'yes',
  ...(sessionId === undefined ? {} : { sessionId }),
});

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A session that exists, and a record of what was written for it. */
function harness(debounceMs = 5) {
  const written: string[] = [];
  const live = new Set<string>(['s1']);
  const handle = attachDriveRunFlush({
    resolve: (id) => (live.has(id) ? { id } : undefined),
    write: async (session) => {
      written.push(session.id);
      await Promise.resolve();
    },
    debounceMs,
  });
  return { written, live, handle };
}

describe('a drive publishes its evidence while the drive is still happening', () => {
  it('writes the run after a verdict, without waiting for the tab to close', async () => {
    const { written, handle } = harness();
    emitHook(verdict('s1'));
    await tick(40);
    expect(written, 'a verdict landed and nothing was written for it').toEqual(['s1']);
    handle.stop();
  });

  it('collapses a burst into ONE write, so a fast drive is not quadratic in its own length', async () => {
    const { written, handle } = harness();
    for (let i = 0; i < 20; i += 1) emitHook(verdict('s1'));
    await tick(40);
    expect(written).toEqual(['s1']);
    handle.stop();
  });

  it('writes again for a verdict that arrives after the previous flush settled', async () => {
    const { written, handle } = harness();
    emitHook(verdict('s1'));
    await tick(40);
    emitHook(verdict('s1'));
    await tick(40);
    expect(written).toEqual(['s1', 's1']);
    handle.stop();
  });

  it('ignores a verdict that names no session — there is nothing to fold', async () => {
    const { written, handle } = harness();
    emitHook(verdict(undefined));
    await tick(40);
    expect(written).toEqual([]);
    handle.stop();
  });

  it('does nothing for a session that has already gone, rather than throwing at a timer', async () => {
    const { written, live, handle } = harness();
    emitHook(verdict('s1'));
    live.delete('s1'); // the tab closed inside the debounce window
    await tick(40);
    expect(written, 'teardown owns the final write; there is nothing to rescue here').toEqual([]);
    handle.stop();
  });

  it('survives a write that throws, and keeps working afterwards', async () => {
    const written: string[] = [];
    let failNext = true;
    const handle = attachDriveRunFlush({
      resolve: (id) => ({ id }),
      write: async (session) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        written.push(session.id);
        await Promise.resolve();
      },
      debounceMs: 5,
    });
    emitHook(verdict('s1'));
    await tick(40);
    emitHook(verdict('s1'));
    await tick(40);
    expect(written, 'one failed flush must not stop the next').toEqual(['s1']);
    handle.stop();
  });

  it('flushes on demand, which is what teardown uses to catch a pending write', async () => {
    const { written, handle } = harness(10_000);
    emitHook(verdict('s1'));
    await handle.flushNow('s1');
    expect(written, 'a debounce pending at teardown would lose the last verdicts').toEqual(['s1']);
    handle.stop();
  });

  it('stops writing once detached', async () => {
    const { written, handle } = harness();
    handle.stop();
    emitHook(verdict('s1'));
    await tick(40);
    expect(written).toEqual([]);
  });
});

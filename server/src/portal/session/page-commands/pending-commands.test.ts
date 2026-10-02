import { describe, expect, it, vi } from 'vitest';
import { PendingCommands, CommandTimeoutError } from './pending-commands.js';

const result = (
  id: string,
  ok = true,
  data?: unknown,
): {
  kind: 'command_result';
  id: string;
  ok: boolean;
  result?: unknown;
} => ({ kind: 'command_result', id, ok, ...(data !== undefined ? { result: data } : {}) });

describe('PendingCommands', () => {
  it('resolves when settle is called with a matching id', async () => {
    const pc = new PendingCommands();
    const id = pc.nextId('c');
    const promise = pc.track(id, 5000, () => 'timed out');
    pc.settle(result(id, true, 'done'));
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.result).toBe('done');
  });

  it('rejects on timeout with a lazy message', async () => {
    const pc = new PendingCommands();
    const id = pc.nextId('c');
    const promise = pc.track(id, 1, () => 'command X timed out');
    await expect(promise).rejects.toThrow('command X timed out');
  });

  it('rejectAll clears every in-flight command', async () => {
    const pc = new PendingCommands();
    const a = pc.track(pc.nextId('c'), 5000, () => '');
    const b = pc.track(pc.nextId('c'), 5000, () => '');
    pc.rejectAll('disconnect');
    await expect(a).rejects.toThrow('disconnect');
    await expect(b).rejects.toThrow('disconnect');
  });

  it('unrefs the timeout timer so an in-flight command cannot hold the daemon open', async () => {
    // The timer object is private, so reach it through setTimeout's return value. Asserting on
    // hasRef() is the whole point: without it this test passes identically with and without the
    // .unref() it exists to prove, which is a green that means nothing.
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const pc = new PendingCommands();
      const id = pc.nextId('c');
      const promise = pc.track(id, 60_000, () => 'should not fire');
      const timer = spy.mock.results[0]?.value as NodeJS.Timeout | undefined;
      expect(timer?.hasRef()).toBe(false);
      pc.settle(result(id));
      await promise;
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The two ways a command can fail mean opposite things, so a caller has to be able to tell them
 * apart. A rejection from a replaced transport says the question never reached the page and is worth
 * asking again; a timeout says the page WAS asked and did not answer in the budget, and asking again
 * spends a budget that is gone. `Session.command` refuses to re-issue a timeout into a replacement
 * on the strength of this type.
 */
describe('a timeout is distinguishable from every other failure', () => {
  it('rejects with CommandTimeoutError, not a bare Error', async () => {
    const pending = new PendingCommands();
    const id = pending.nextId('c');
    await expect(pending.track(id, 1, () => 'timed out')).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
  });

  it('and a rejectAll is NOT one — that is a transport failure, which may be retried', async () => {
    const pending = new PendingCommands();
    const id = pending.nextId('c');
    const call = pending.track(id, 10_000, () => 'timed out');
    pending.rejectAll('session replaced by a newer connection claiming the same id');
    await expect(call).rejects.not.toBeInstanceOf(CommandTimeoutError);
  });
});

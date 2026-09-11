import { describe, expect, it } from 'vitest';
import { withFileLock, chainSize } from './file-lock.js';

describe('withFileLock', () => {
  it('serializes concurrent calls to the same path', async () => {
    const order: number[] = [];
    const gate1 = deferred();
    const gate2 = deferred();

    const task1 = withFileLock('/serial-1', async () => {
      order.push(1);
      await gate1.promise;
      order.push(2);
      return 'one';
    });

    const task2 = withFileLock('/serial-1', async () => {
      order.push(3);
      await gate2.promise;
      order.push(4);
      return 'two';
    });

    // task1 runs immediately; task2 is queued behind it.
    await tick();
    expect(order).toEqual([1]);

    gate1.resolve();
    await tick();
    // task1 finished, task2 starts
    expect(order).toEqual([1, 2, 3]);

    gate2.resolve();
    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(await task1).toBe('one');
    expect(await task2).toBe('two');
  });

  it('does NOT serialize calls to different paths', async () => {
    const order: number[] = [];
    const gate1 = deferred();
    const gate2 = deferred();

    const task1 = withFileLock('/indep-a', async () => {
      order.push(1);
      await gate1.promise;
      return 'a';
    });

    const task2 = withFileLock('/indep-b', async () => {
      order.push(2);
      await gate2.promise;
      return 'b';
    });

    await tick();
    // Both started concurrently — no serialization across different paths.
    expect(order).toEqual([1, 2]);

    gate1.resolve();
    gate2.resolve();
    await Promise.all([task1, task2]);
  });

  it('a rejected task does not break the next waiter', async () => {
    const task1 = withFileLock('/reject-1', () => Promise.reject(new Error('boom')));

    const task2 = withFileLock('/reject-1', () => Promise.resolve('recovered'));

    await expect(task1).rejects.toThrow('boom');
    expect(await task2).toBe('recovered');
  });

  it('cleans up the chain entry when no successor is queued', async () => {
    await withFileLock('/cleanup-1', () => Promise.resolve('done'));
    await tick();
    expect(chainSize()).toBe(0);
  });

  it('does NOT clean up while a successor is still queued', async () => {
    const gate = deferred();

    const task1 = withFileLock('/busy-1', () => gate.promise);

    const task2 = withFileLock('/busy-1', () => Promise.resolve('second'));

    await tick();
    // task1 is running, task2 is queued — entry must remain.
    expect(chainSize()).toBe(1);

    gate.resolve();
    await Promise.all([task1, task2]);
    await tick();
    // Both finished, no more waiters — cleaned up.
    expect(chainSize()).toBe(0);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

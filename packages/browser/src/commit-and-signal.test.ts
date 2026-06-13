import { describe, it, expect, vi } from 'vitest';
import { commitAndSignal } from './commit-and-signal.js';
import type { IrisEmitter } from './emitter.js';

function spyEmitter(): IrisEmitter & { signal: ReturnType<typeof vi.fn> } {
  return { signal: vi.fn(), state: vi.fn() };
}

describe('commitAndSignal (P5b drift-proof pairing)', () => {
  it('runs mutate then emits the signal exactly once', () => {
    const emitter = spyEmitter();
    let mutated = false;
    commitAndSignal(
      emitter,
      () => {
        mutated = true;
      },
      'n',
    );
    expect(mutated).toBe(true);
    expect(emitter.signal).toHaveBeenCalledTimes(1);
  });

  it('mutate runs before the signal', () => {
    const emitter = spyEmitter();
    const order: string[] = [];
    emitter.signal.mockImplementation(() => order.push('signal'));
    commitAndSignal(emitter, () => order.push('mutate'), 'n');
    expect(order).toEqual(['mutate', 'signal']);
  });

  it('returns the mutate result', () => {
    const emitter = spyEmitter();
    expect(commitAndSignal(emitter, () => 42, 'n')).toBe(42);
  });

  it('returns an object mutate result (generic T)', () => {
    const emitter = spyEmitter();
    const result = commitAndSignal(emitter, () => ({ id: 'a' }), 'n');
    expect(result).toEqual({ id: 'a' });
  });

  it('forwards the data payload to the signal', () => {
    const emitter = spyEmitter();
    commitAndSignal(emitter, () => undefined, 'sec:reordered', { fromId: 1, toId: 2 });
    expect(emitter.signal).toHaveBeenCalledWith('sec:reordered', { fromId: 1, toId: 2 });
  });

  it('defaults data when omitted', () => {
    const emitter = spyEmitter();
    commitAndSignal(emitter, () => undefined, 'n');
    expect(emitter.signal).toHaveBeenCalledWith('n', undefined);
  });

  it('does NOT emit the signal when mutate throws', () => {
    const emitter = spyEmitter();
    try {
      commitAndSignal(
        emitter,
        () => {
          throw new Error('boom');
        },
        'n',
      );
    } catch {
      /* swallow for this assertion */
    }
    expect(emitter.signal).not.toHaveBeenCalled();
  });

  it('propagates the throw when mutate throws', () => {
    const emitter = spyEmitter();
    expect(() =>
      commitAndSignal(
        emitter,
        () => {
          throw new Error('boom');
        },
        'n',
      ),
    ).toThrow('boom');
  });

  it('still runs mutate and returns when the emitter is a no-op', () => {
    const noop: IrisEmitter = { signal: () => undefined, state: () => undefined };
    let counter = 0;
    const result = commitAndSignal(
      noop,
      () => {
        counter += 1;
        return counter;
      },
      'n',
    );
    expect(counter).toBe(1);
    expect(result).toBe(1);
  });

  it('emits exactly once (not twice) on success', () => {
    const emitter = spyEmitter();
    commitAndSignal(emitter, () => undefined, 'n');
    expect(emitter.signal).toHaveBeenCalledTimes(1);
  });
});

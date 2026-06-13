import { describe, it, expect, vi } from 'vitest';
import { createIrisEmitter } from './emitter.js';

interface FakeTarget {
  connected: boolean;
  signal: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>;
}

function fakeTarget(connected: boolean): FakeTarget {
  return { connected, signal: vi.fn(), state: vi.fn() };
}

describe('createIrisEmitter (P5a inject-the-emitter)', () => {
  it('forwards signal to target when connected', () => {
    const target = fakeTarget(true);
    const e = createIrisEmitter({ target });
    e.signal('order:saved', { id: 1 });
    expect(target.signal).toHaveBeenCalledTimes(1);
    expect(target.signal).toHaveBeenCalledWith('order:saved', { id: 1 });
  });

  it('forwards state to target when connected', () => {
    const target = fakeTarget(true);
    const e = createIrisEmitter({ target });
    e.state('cart', { items: 3 });
    expect(target.state).toHaveBeenCalledTimes(1);
    expect(target.state).toHaveBeenCalledWith('cart', { items: 3 });
  });

  it('defaults signal data to an empty object', () => {
    const target = fakeTarget(true);
    const e = createIrisEmitter({ target });
    e.signal('ping');
    expect(target.signal).toHaveBeenCalledWith('ping', {});
  });

  it('signal is a no-op when target not connected (no throw, no effect)', () => {
    const target = fakeTarget(false);
    const e = createIrisEmitter({ target });
    expect(() => e.signal('x', {})).not.toThrow();
    expect(target.signal).not.toHaveBeenCalled();
  });

  it('state is a no-op when target not connected', () => {
    const target = fakeTarget(false);
    const e = createIrisEmitter({ target });
    expect(() => e.state('x', 1)).not.toThrow();
    expect(target.state).not.toHaveBeenCalled();
  });

  it('re-reads connected per call (created before connect)', () => {
    const target = fakeTarget(false);
    const e = createIrisEmitter({ target });
    e.signal('x', {});
    expect(target.signal).not.toHaveBeenCalled();
    target.connected = true;
    e.signal('x', {});
    expect(target.signal).toHaveBeenCalledTimes(1);
  });

  it('default target is the iris singleton (disconnected -> no-op, no throw)', () => {
    const e = createIrisEmitter();
    expect(() => e.signal('x')).not.toThrow();
    expect(() => e.state('x', 1)).not.toThrow();
  });

  it('works when the iris singleton is present but never connected', async () => {
    const { iris } = await import('../index.js');
    expect(iris.connected).toBe(false);
    const e = createIrisEmitter();
    expect(() => e.signal('x', {})).not.toThrow();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { SESSION_LIFECYCLE } from '@reticlehq/core';
import { IdleShutdown, resolveIdleShutdownMs } from './idle-shutdown.js';

/** A controllable clock + idle flag, so the watcher is driven deterministically. */
function harness(opts: { graceMs?: number; idle?: boolean } = {}) {
  let now = 0;
  let idle = opts.idle ?? true;
  const onShutdown = vi.fn();
  const watcher = new IdleShutdown({
    graceMs: opts.graceMs ?? 1000,
    isIdle: () => idle,
    onShutdown,
    clock: () => now,
  });
  return {
    watcher,
    onShutdown,
    advance: (ms: number) => (now += ms),
    setIdle: (v: boolean) => (idle = v),
  };
}

describe('IdleShutdown', () => {
  it('shuts down after graceMs of continuous idleness', () => {
    const h = harness({ graceMs: 1000 });
    h.watcher.check(); // idleSince = 0
    expect(h.onShutdown).not.toHaveBeenCalled();
    h.advance(999);
    h.watcher.check();
    expect(h.onShutdown).not.toHaveBeenCalled(); // not yet
    h.advance(1);
    h.watcher.check();
    expect(h.onShutdown).toHaveBeenCalledTimes(1); // hit the grace window
  });

  it('does NOT shut down while busy, and resets the idle clock on any activity', () => {
    const h = harness({ graceMs: 1000 });
    h.watcher.check(); // idle since 0
    h.advance(800);
    h.setIdle(false); // an agent reconnected / a session appeared
    h.watcher.check(); // resets idleSince
    h.advance(800);
    h.setIdle(true);
    h.watcher.check(); // idle again, but the clock restarts here
    h.advance(999);
    h.watcher.check();
    expect(h.onShutdown).not.toHaveBeenCalled(); // < grace since it went idle again
    h.advance(1);
    h.watcher.check();
    expect(h.onShutdown).toHaveBeenCalledTimes(1);
  });

  it('fires onShutdown at most once', () => {
    const h = harness({ graceMs: 100 });
    h.watcher.check();
    h.advance(200);
    h.watcher.check();
    h.watcher.check();
    h.advance(1000);
    h.watcher.check();
    expect(h.onShutdown).toHaveBeenCalledTimes(1);
  });

  it('graceMs <= 0 disables the watcher (start() is a no-op)', () => {
    const h = harness({ graceMs: 0 });
    h.watcher.start(); // must not arm a timer
    h.watcher.check();
    h.advance(1_000_000);
    h.watcher.check();
    expect(h.onShutdown).not.toHaveBeenCalled();
  });
});

describe('resolveIdleShutdownMs', () => {
  const D = SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS;
  it('defaults when unset/blank/invalid', () => {
    expect(resolveIdleShutdownMs(undefined)).toBe(D);
    expect(resolveIdleShutdownMs('')).toBe(D);
    expect(resolveIdleShutdownMs('  ')).toBe(D);
    expect(resolveIdleShutdownMs('nope')).toBe(D);
    expect(resolveIdleShutdownMs('-5')).toBe(D);
  });
  it('honors 0 (disable) and explicit values', () => {
    expect(resolveIdleShutdownMs('0')).toBe(0);
    expect(resolveIdleShutdownMs('120000')).toBe(120000);
  });

  /**
   * The resolver returning 0 is NOT the property anyone cares about — "the daemon does not exit" is,
   * and the disable lives one level up, in IdleShutdown. Asserting only the number is what let a
   * reviewer read `Math.floor(0)` with no branch beside it, conclude the option was documented but
   * unimplemented, and report the fixtures gate that depends on it as inverted. Wire the two ends
   * together so the question is answered by running something rather than by reading.
   */
  it('0 from the environment really does stop the daemon from ever exiting', () => {
    const onShutdown = vi.fn();
    let now = 0;
    const watcher = new IdleShutdown({
      graceMs: resolveIdleShutdownMs('0'),
      isIdle: () => true,
      onShutdown,
      clock: () => now,
    });
    watcher.start();
    // Far past any grace, including the attached-client multiplier.
    for (const step of [1_000, 60_000, 3_600_000, 86_400_000]) {
      now += step;
      watcher.check();
    }
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('the default, by contrast, does exit — so the test above is not vacuous', () => {
    const onShutdown = vi.fn();
    let now = 0;
    const watcher = new IdleShutdown({
      graceMs: resolveIdleShutdownMs(undefined),
      isIdle: () => true,
      onShutdown,
      clock: () => now,
    });
    watcher.check();
    now += D + 1;
    watcher.check();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});

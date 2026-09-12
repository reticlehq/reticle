import { describe, expect, it, vi } from 'vitest';
import { SESSION_LIFECYCLE } from '@reticlehq/core';
import { idleGraceMs } from '../daemon/idle-grace.js';
import { PROXY_IDLE_EXIT_MS, ProxyIdleExit, resolveProxyIdleExitMs } from './proxy-idle-exit.js';

function harness(opts: { graceMs?: number; busy?: boolean } = {}) {
  let now = 0;
  let busy = opts.busy ?? false;
  const onExit = vi.fn();
  const watcher = new ProxyIdleExit({
    graceMs: opts.graceMs ?? 1_000,
    checkIntervalMs: 10,
    isBusy: () => busy,
    onExit,
    clock: () => now,
  });
  return {
    watcher,
    onExit,
    advance: (ms: number) => (now += ms),
    setBusy: (value: boolean) => (busy = value),
  };
}

describe('ProxyIdleExit', () => {
  it('waits a full day, much longer than the daemon even when an agent is attached', () => {
    const attachedDaemonGrace = idleGraceMs(SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS, true);
    expect(PROXY_IDLE_EXIT_MS).toBe(24 * 60 * 60_000);
    expect(PROXY_IDLE_EXIT_MS).toBeGreaterThan(attachedDaemonGrace);
  });

  it('exits after the client link stays quiet for the whole grace', () => {
    const h = harness();
    h.advance(999);
    h.watcher.check();
    expect(h.onExit).not.toHaveBeenCalled();

    h.advance(1);
    h.watcher.check();
    expect(h.onExit).toHaveBeenCalledOnce();
    expect(h.onExit).toHaveBeenCalledWith(1_000);
  });

  it('restarts the grace window whenever client traffic arrives', () => {
    const h = harness();
    h.advance(800);
    h.watcher.noteTraffic();

    h.advance(999);
    h.watcher.check();
    expect(h.onExit).not.toHaveBeenCalled();

    h.advance(1);
    h.watcher.check();
    expect(h.onExit).toHaveBeenCalledWith(1_000);
  });

  it('does not exit while a client request is still being served', () => {
    const h = harness({ busy: true });
    h.advance(5_000);
    h.watcher.check();
    expect(h.onExit).not.toHaveBeenCalled();

    h.setBusy(false);
    h.watcher.check(); // the busy → idle transition starts a complete new grace window
    h.advance(999);
    h.watcher.check();
    expect(h.onExit).not.toHaveBeenCalled();

    h.advance(1);
    h.watcher.check();
    expect(h.onExit).toHaveBeenCalledWith(1_000);
  });

  it('fires at most once', () => {
    const h = harness({ graceMs: 100 });
    h.advance(100);
    h.watcher.check();
    h.advance(1_000);
    h.watcher.check();
    h.watcher.noteTraffic();
    h.watcher.check();
    expect(h.onExit).toHaveBeenCalledOnce();
  });

  it('treats a non-positive grace as disabled', () => {
    const h = harness({ graceMs: 0 });
    h.watcher.start();
    h.advance(86_400_000);
    h.watcher.check();
    expect(h.onExit).not.toHaveBeenCalled();
  });
});

describe('resolveProxyIdleExitMs', () => {
  it('defaults on missing, blank, negative, or invalid values', () => {
    for (const raw of [undefined, '', '  ', '-1', 'nope']) {
      expect(resolveProxyIdleExitMs(raw)).toBe(PROXY_IDLE_EXIT_MS);
    }
  });

  it('accepts an explicit grace and zero as the opt-out', () => {
    expect(resolveProxyIdleExitMs('120000')).toBe(120_000);
    expect(resolveProxyIdleExitMs('0')).toBe(0);
  });
});

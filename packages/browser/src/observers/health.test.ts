import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventType, HealthReason } from '@reticlehq/core';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('installHealth (jsdom)', () => {
  it('emits an initial PAGE_HEALTH baseline with hidden/focused booleans', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);

    const initial = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.INITIAL,
    );
    expect(initial?.[0]).toBe(EventType.PAGE_HEALTH);
    const data = initial?.[1] as { hidden: unknown; focused: unknown };
    expect(typeof data.hidden).toBe('boolean');
    expect(typeof data.focused).toBe('boolean');
    teardown();
  });

  it('reports on visibilitychange and stops after teardown', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    emit.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const vis = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.VISIBILITY,
    );
    expect(vis).toBeDefined();
    expect((vis?.[1] as { hidden: boolean }).hidden).toBe(true);

    teardown();
    emit.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports on window blur', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    emit.mockClear();

    window.dispatchEvent(new Event('blur'));
    const blur = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.BLUR,
    );
    expect(blur?.[0]).toBe(EventType.PAGE_HEALTH);
    teardown();
  });
});

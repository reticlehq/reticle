import { describe, expect, it, vi } from 'vitest';
import { harnessConfigSource } from './harness-config.js';

const config = (enabled: boolean) => ({
  provider: 'jev',
  harnessEnabled: enabled,
  harnessEntitled: true,
  providerReady: true,
});
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('HUD Harness configuration cache', () => {
  it('publishes an accepted switch immediately and ignores a read started before the write', async () => {
    let answer: ((value: ReturnType<typeof config>) => void) | undefined;
    const source = harnessConfigSource(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const changed = vi.fn();
    source.subscribe(changed);
    source.applyWrite(false);
    answer?.(config(true));
    await flush();
    expect(source.read()).toBeUndefined(); // Initial read cannot override the accepted write.
    expect(changed).toHaveBeenCalled();
  });

  it('updates the live cache after an accepted write and notifies the HUD', async () => {
    const source = harnessConfigSource(() => Promise.resolve(config(true)));
    await flush();
    const changed = vi.fn();
    source.subscribe(changed);
    source.applyWrite(false);
    expect(source.read()?.harnessEnabled).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('rechecks the platform after a refused write so the HUD can roll back', async () => {
    let enabled = true;
    const source = harnessConfigSource(() => Promise.resolve(config(enabled)));
    await flush();
    const changed = vi.fn();
    source.subscribe(changed);
    enabled = false;
    source.recheck();
    await flush();
    expect(source.read()?.harnessEnabled).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it('hears a switch flipped somewhere else, and stays quiet when nothing changed', async () => {
    let enabled = true;
    const source = harnessConfigSource(() => Promise.resolve(config(enabled)));
    await flush();
    const changed = vi.fn();
    source.subscribe(changed);
    source.poll();
    await flush();
    expect(changed).not.toHaveBeenCalled();
    enabled = false;
    source.poll();
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(source.read()?.harnessEnabled).toBe(false);
  });
});

/**
 * The HUD learned about the platform only when something pushed: sync status, runs on the dashboard
 * and days left stayed stale on an idle tab until the next tool call. The daemon now re-reads every
 * tab on a timer, and a timed refresh sends only what changed.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ImpactSnapshot } from '@reticlehq/core';
import { HUD_REFRESH_MS, pushIfMoved, watchAccountFiles } from './account-watch.js';

const tab = () => {
  const pushed: unknown[] = [];
  return {
    pushed,
    pushImpact: (read: () => ImpactSnapshot | undefined): void => void pushed.push(read()),
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshing a tab from the platform', () => {
  it('sends a snapshot that changed, and nothing for one that did not', () => {
    const t = tab();
    let signedIn = false;
    const read = () => ({ account: { signedIn } }) as unknown as ImpactSnapshot;
    pushIfMoved(t, read, true);
    pushIfMoved(t, read, true);
    expect(t.pushed).toHaveLength(1);
    signedIn = true;
    pushIfMoved(t, read, true);
    expect(t.pushed).toHaveLength(2);
  });

  it('a repaint that is not a refresh always goes out', () => {
    const t = tab();
    const read = () => ({}) as ImpactSnapshot;
    pushIfMoved(t, read, false);
    pushIfMoved(t, read, false);
    expect(t.pushed).toHaveLength(2);
  });

  it('ticks every 30s until closed', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const watch = watchAccountFiles(() => undefined, undefined, onTick);
    vi.advanceTimersByTime(HUD_REFRESH_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(2);
    watch.close();
    vi.advanceTimersByTime(HUD_REFRESH_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});

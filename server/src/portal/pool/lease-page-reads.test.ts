/**
 * The two values a lease reads back from its page: the viewport after a resize, and the
 * notification permission after a grant. Each answers undefined when the page cannot say.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PooledPage } from './pool-contract.js';
import { readViewport } from './lease-emulation.js';
import { NOTIFICATION_READ_TIMEOUT_MS, readNotificationPermission } from './context-permissions.js';

const pageThatAnswers = (evaluate?: PooledPage['evaluate']): PooledPage =>
  ({ ...(evaluate === undefined ? {} : { evaluate }) }) as PooledPage;

describe('reading the viewport back', () => {
  it('returns the width and height the page reports', async () => {
    const page = pageThatAnswers(() => Promise.resolve([390, 844]));
    expect(await readViewport(page)).toEqual({ width: 390, height: 844 });
  });

  it('is undefined when the page cannot evaluate, answers a wrong shape, or throws', async () => {
    expect(await readViewport(pageThatAnswers())).toBeUndefined();
    expect(await readViewport(pageThatAnswers(() => Promise.resolve('390x844')))).toBeUndefined();
    expect(
      await readViewport(pageThatAnswers(() => Promise.reject(new Error('gone')))),
    ).toBeUndefined();
  });
});

describe('reading the notification permission back', () => {
  it('returns the string the page reports', async () => {
    const page = pageThatAnswers(() => Promise.resolve('denied'));
    expect(await readNotificationPermission(page)).toBe('denied');
  });

  it('is undefined when the page cannot evaluate, answers a non-string, or throws', async () => {
    expect(await readNotificationPermission(pageThatAnswers())).toBeUndefined();
    expect(
      await readNotificationPermission(pageThatAnswers(() => Promise.resolve(1))),
    ).toBeUndefined();
    expect(
      await readNotificationPermission(pageThatAnswers(() => Promise.reject(new Error('gone')))),
    ).toBeUndefined();
  });

  it('gives up when the page never answers', async () => {
    vi.useFakeTimers();
    try {
      const reading = readNotificationPermission(
        pageThatAnswers(() => new Promise(() => undefined)),
      );
      await vi.advanceTimersByTimeAsync(NOTIFICATION_READ_TIMEOUT_MS);
      expect(await reading).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

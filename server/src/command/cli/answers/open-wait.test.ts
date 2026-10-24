import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNewSession, type OpenWaitStatus } from './open-wait.js';

describe('waitForNewSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the refusal lead when the wait ends with no new session', async () => {
    vi.useFakeTimers();
    const whyLead =
      'the page dialled this daemon and was REFUSED because the wire contract does not match.';
    const read = vi.fn((): Promise<OpenWaitStatus> => Promise.resolve({ whyLead, sessions: [] }));
    const pending = waitForNewSession(0, read);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toEqual({ connected: false, whyLead });
  });

  it('reports connected and drops the lead once a new session is listed', async () => {
    vi.useFakeTimers();
    const read = vi.fn((): Promise<OpenWaitStatus> =>
      Promise.resolve({ whyLead: 'was REFUSED', sessions: [{ sessionId: 's1' }] }),
    );
    const pending = waitForNewSession(0, read);
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toEqual({ connected: true });
  });
});

import { describe, expect, it } from 'vitest';
import {
  FreeDriveKind,
  fetchPlatformRun,
  planUrl,
  requestFreeDrive,
  type PlatformFetch,
} from './platform-drives.js';

const CLOUD = { url: 'https://app.reticle.test', apiKey: 'rk_live_x' };

describe('requestFreeDrive', () => {
  const answering =
    (status: number, body: unknown, seen: { url?: string; init?: unknown } = {}): PlatformFetch =>
    (url, init) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
    };

  it('posts kind "try" with the key and returns the granted drive', async () => {
    const seen: { url?: string; init?: unknown } = {};
    const grant = await requestFreeDrive(
      CLOUD,
      FreeDriveKind.TRY,
      answering(200, { granted: true, driveId: 'drv_9' }, seen),
    );
    expect(grant).toEqual({ granted: true, driveId: 'drv_9' });
    expect(seen.url).toBe('https://app.reticle.test/v1/harness/free-drive');
    expect(seen.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ kind: 'try' }),
      headers: { authorization: 'Bearer rk_live_x' },
    });
  });

  it('reads a 402 as needing a card, with the platform message', async () => {
    expect(
      await requestFreeDrive(
        CLOUD,
        FreeDriveKind.TRY,
        answering(402, {
          error: 'needs_card',
          capability: 'harness',
          message: 'Add a card.',
          hint: 'h',
        }),
      ),
    ).toEqual({ granted: false, needsCard: true, message: 'Add a card.', hint: 'h' });
  });

  it('turns an unreachable platform into an answer rather than a throw', async () => {
    const grant = await requestFreeDrive(CLOUD, FreeDriveKind.TRY, () =>
      Promise.reject(new Error('offline')),
    );
    expect(grant).toMatchObject({ granted: false, needsCard: false });
  });
});

describe('the run the platform kept', () => {
  const answering =
    (status: number, body: unknown, seen: { url?: string } = {}): PlatformFetch =>
    (url) => {
      seen.url = url;
      return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
    };

  it('GETs the run by id with the key', async () => {
    const seen: { url?: string } = {};
    const answer = await fetchPlatformRun(
      CLOUD,
      'harness-1',
      answering(200, { runId: 'harness-1', status: 'done' }, seen),
    );
    expect(seen.url).toBe('https://app.reticle.test/v1/runs/harness-1');
    expect(answer).toEqual({ run: { runId: 'harness-1', status: 'done' } });
  });

  it('says a missing run may not have synced yet, rather than that it never existed', async () => {
    expect(await fetchPlatformRun(CLOUD, 'harness-2', answering(404, {}))).toEqual({
      error: expect.stringContaining('not synced yet, or not found') as unknown,
    });
  });

  it('turns an unreachable platform into an answer', async () => {
    const answer = await fetchPlatformRun(CLOUD, 'harness-3', () =>
      Promise.reject(new Error('offline')),
    );
    expect('error' in answer).toBe(true);
  });
});

describe('where a trial starts', () => {
  it("is the billing settings at the dashboard's origin, whatever path the link carried", () => {
    expect(planUrl('https://app.reticle.test/p/123')).toBe(
      'https://app.reticle.test/settings?group=billing',
    );
  });
});

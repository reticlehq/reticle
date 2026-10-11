import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ScreenshotUploadSchema } from '@reticlehq/core/artifacts';
import { syncScreenshots, type ScreenshotSyncDeps } from './sync-screenshots.js';

/**
 * A run's screenshots follow it to the platform once it holds the run, once each — and an older
 * platform that has no endpoint for them costs one refused request, not one per image per cycle.
 */

const IMAGE = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const SHA = createHash('sha256').update(IMAGE).digest('hex');

function shot(seq: number) {
  return {
    seq,
    file: `000${String(seq)}-act.jpg`,
    tool: 'reticle_act',
    source: 'browser',
    width: 1280,
    height: 720,
    sha256: SHA,
  };
}

function deps(
  answer: (path: string) => number,
  overrides: Partial<ScreenshotSyncDeps> = {},
): { deps: ScreenshotSyncDeps; posted: Array<{ path: string; body: unknown }> } {
  const posted: Array<{ path: string; body: unknown }> = [];
  return {
    posted,
    deps: {
      runs: [{ runId: 'run-1', payload: { runId: 'run-1', screenshots: [shot(1), shot(2)] } }],
      accepted: () => true,
      readImage: () => IMAGE,
      state: {},
      post: (path, body) => {
        posted.push({ path, body: JSON.parse(body) });
        return Promise.resolve({ status: answer(path), text: '' });
      },
      ...overrides,
    },
  };
}

describe('syncScreenshots', () => {
  it('sends each screenshot of an accepted run once, in the shape the platform reads', async () => {
    const { deps: d, posted } = deps(() => 201);

    const first = await syncScreenshots(d);
    const again = await syncScreenshots({ ...d, state: first.state });

    expect(first.sent).toBe(2);
    expect(posted.map((p) => p.path)).toEqual([
      '/v1/runs/run-1/screenshots',
      '/v1/runs/run-1/screenshots',
    ]);
    expect(ScreenshotUploadSchema.parse(posted[0]?.body)).toEqual({
      ...shot(1),
      jpeg: Buffer.from(IMAGE).toString('base64'),
    });
    expect(again.sent).toBe(0);
    expect(posted).toHaveLength(2);
  });

  it('waits for the platform to hold the run first', async () => {
    const { deps: d, posted } = deps(() => 201, { accepted: () => false });

    expect((await syncScreenshots(d)).sent).toBe(0);
    expect(posted).toHaveLength(0);
  });

  it('keeps a run local when the platform has no endpoint for screenshots, and never asks again', async () => {
    const { deps: d, posted } = deps(() => 404);

    const first = await syncScreenshots(d);
    await syncScreenshots({ ...d, state: first.state });

    expect(first.error).toContain('stay on this machine');
    expect(posted).toHaveLength(1);
  });

  it('retries next cycle after a failure that could pass, and not after one that cannot', async () => {
    const down = deps(() => 503);
    const stillOwed = await syncScreenshots(down.deps);
    expect(stillOwed.state.sentScreenshots).toEqual({});

    const tooBig = deps(() => 413);
    const refused = await syncScreenshots(tooBig.deps);
    await syncScreenshots({ ...tooBig.deps, state: refused.state });
    expect(tooBig.posted).toHaveLength(2);
  });

  it('sends nothing for an image that is gone or changed since the run recorded it', async () => {
    const { deps: d, posted } = deps(() => 201, {
      readImage: (_run, file) => (file.startsWith('0001') ? undefined : new Uint8Array([9])),
    });

    expect((await syncScreenshots(d)).sent).toBe(0);
    expect(posted).toHaveLength(0);
  });
});

/**
 * A decision made on the dashboard reached an idle laptop only on the ten-minute backstop (measured:
 * 590 s). An idle daemon now asks once a minute whether the team's memory moved, conditionally: the
 * platform answers a bodiless 304 while nothing did, so the minute costs one tiny request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSyncDaemon } from './sync-daemon.js';
import type { ProjectCloud } from './cloud-config.js';

vi.mock('@/hooks/hook-emit.js', () => ({ emitSyncHook: vi.fn() }));

const LINKED: ProjectCloud = {
  config: { url: 'https://cloud.test', apiKey: 'rk_test' },
  policy: { runs: true, memory: true, flows: true, capsules: true, screenshots: true, video: true },
  verify: 'local',
  projectId: 'demo',
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-poll-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A platform whose memory carries a tag, and answers 304 to a read that names it. */
function platform() {
  let tag = '"one"';
  const memory: Array<{ status: number; at: number }> = [];
  const request = (
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<{ status: number; text: string; etag?: string }> => {
    if (url.includes('/v1/memory')) {
      const status = init.headers['if-none-match'] === tag ? 304 : 200;
      memory.push({ status, at: Date.now() });
      const text = 304 === status ? '' : JSON.stringify({ projectId: 'demo', entries: [] });
      return Promise.resolve({ status, text, etag: tag });
    }
    const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
    return Promise.resolve({ status: 200, text: JSON.stringify(body) });
  };
  return { request, memory, decide: () => (tag = '"two"') };
}

describe('an idle machine and the team memory', () => {
  it('asks once a minute, and a 304 is all an unchanged minute costs', async () => {
    const p = platform();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: p.request,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    d.stop();
    const reads = p.memory.length;
    expect(reads).toBeGreaterThanOrEqual(9);
    expect(reads).toBeLessThanOrEqual(12);
    expect(p.memory.filter((r) => 200 === r.status).length).toBeLessThanOrEqual(2);
  });

  it('brings a dashboard decision down within a minute', async () => {
    const p = platform();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: p.request,
    });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const decidedAt = Date.now();
    p.decide();
    await vi.advanceTimersByTimeAsync(60_000);
    d.stop();
    const full = p.memory.filter((r) => 200 === r.status && r.at >= decidedAt);
    expect(full.length).toBeGreaterThanOrEqual(1);
    expect((full[0]?.at ?? Infinity) - decidedAt).toBeLessThanOrEqual(60_000);
  });
});

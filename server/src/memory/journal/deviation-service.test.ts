import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { EnvelopeStore } from './envelope-store.js';
import { reportAndAccumulate } from './deviation-service.js';
import type { SegmentRollup } from './rollups.js';

function seg(route: string, durationMs: number): SegmentRollup {
  return {
    route,
    from: 0,
    to: durationMs,
    durationMs,
    actions: 1,
    net: { total: 2, errors: 0 },
    consoleErrors: 0,
    statePathsChanged: [],
  };
}

/**
 * A BOUND, not a measurement. Every test below drives the envelope through a loop, and each
 * iteration reads and rewrites the store on the real filesystem — the cost is per-iteration IO, not
 * the three or four samples the loop counts. Cheap on macOS and Linux, much slower on a Windows
 * runner, where vitest's 5 s default would decide the result instead of the assertion.
 */
const ENVELOPE_IO_TIMEOUT_MS = 30_000;

describe('reportAndAccumulate — the push-default loop', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: EnvelopeStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-dev-svc-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new EnvelopeStore(fs, root);
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it(
    'is silent on early runs, then catches a regression once the envelope matures',
    async () => {
      // First runs: too few samples — falls back to the causal summary.
      for (const d of [100, 110, 95]) {
        const report = await reportAndAccumulate(store, [seg('/checkout', d)]);
        expect(report.insufficientSamples).toBe(true);
      }
      // A now-established route stays nominal on a healthy run…
      const healthy = await reportAndAccumulate(store, [seg('/checkout', 104)]);
      expect(healthy.insufficientSamples).toBe(false);
      expect(healthy.deviations).toEqual([]);
      expect(healthy.headline).toContain('nominal');

      // …and flags a real slowdown, naming the route.
      const regressed = await reportAndAccumulate(store, [seg('/checkout', 1500)]);
      expect(regressed.deviations[0]?.route).toBe('/checkout');
      expect(regressed.headline).toContain('/checkout');
    },
    ENVELOPE_IO_TIMEOUT_MS,
  );

  it(
    'never learns from a truncated segment (its understated counts would poison the baseline)',
    async () => {
      for (const d of [100, 110, 95]) await reportAndAccumulate(store, [seg('/a', d)]);
      // A truncated run (understated counts) must not fold into the envelope.
      await reportAndAccumulate(store, [{ ...seg('/a', 0), truncated: true }]);
      const loaded = await store.load();
      expect(loaded.get('/a')?.samples).toBe(3); // still 3 — the truncated run was not learned
    },
    ENVELOPE_IO_TIMEOUT_MS,
  );

  it(
    'persists the accumulated baseline across separate store instances (run to run)',
    async () => {
      for (const d of [100, 110, 95, 105]) await reportAndAccumulate(store, [seg('/a', d)]);
      const fresh = new EnvelopeStore(fs, root); // a later daemon run
      const report = await reportAndAccumulate(fresh, [seg('/a', 100)]);
      expect(report.insufficientSamples).toBe(false);
    },
    ENVELOPE_IO_TIMEOUT_MS,
  );
});

/**
 * The defect this templating exists for, end to end.
 *
 * Keyed on the raw pathname, an app with ids in its URLs mints one envelope per id. Every envelope
 * holds a single sample, nothing ever reaches MIN_ENVELOPE_SAMPLES, and the report answers
 * "envelope too new" for the life of the project — the deviation feature silently never turns on,
 * and the file grows a key per order at the same time. One defect, two symptoms.
 */
describe('an app whose URLs carry ids', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: EnvelopeStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-dev-ids-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new EnvelopeStore(fs, root);
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it(
    'accumulates visits to different ids into ONE envelope, so the baseline matures',
    async () => {
      for (const id of [1001, 1002, 1003]) {
        await reportAndAccumulate(store, [seg(`/orders/${String(id)}`, 100)]);
      }
      const envelopes = await store.load();
      expect(envelopes.size).toBe(1);
      expect([...envelopes.values()][0]?.samples).toBe(3);
    },
    ENVELOPE_IO_TIMEOUT_MS,
  );

  it(
    'stops reporting "too new" once enough DIFFERENT ids have been seen',
    async () => {
      for (const id of [1, 2, 3]) {
        await reportAndAccumulate(store, [seg(`/orders/${String(id)}`, 100)]);
      }
      const report = await reportAndAccumulate(store, [seg('/orders/4', 100)]);
      expect(report.insufficientSamples).toBe(false);
    },
    ENVELOPE_IO_TIMEOUT_MS,
  );

  /** And genuinely different routes still get their own baselines. */
  it(
    'keeps two different route templates apart',
    async () => {
      await reportAndAccumulate(store, [seg('/orders/1', 100)]);
      await reportAndAccumulate(store, [seg('/invoices/1', 100)]);
      expect((await store.load()).size).toBe(2);
    },
    ENVELOPE_IO_TIMEOUT_MS,
  );
});

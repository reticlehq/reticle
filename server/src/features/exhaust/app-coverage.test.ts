import { describe, expect, it } from 'vitest';
import type { ReticleEvent } from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { foldAppCoverage } from './app-coverage.js';

const session = (acted: string[], proved: string[]) => ({
  url: 'http://h/cart',
  actedLabels: () => new Set(acted),
  provedLabels: () => new Set(proved),
  eventsSince: (): ReticleEvent[] => [],
});

describe('foldAppCoverage', () => {
  it('accumulates across sessions in .reticle/coverage.json', async () => {
    const { fs } = createMemoryFs();
    await foldAppCoverage({
      now: () => 0,
      fs,
      reticleRoot: '/p/.reticle',
      seen: ['a', 'b'],
      session: session(['a'], []),
    });
    const second = await foldAppCoverage({
      now: () => 0,
      fs,
      reticleRoot: '/p/.reticle',
      seen: ['b'],
      session: session(['b'], ['b']),
    });
    const touched = second.levels.find((l) => 'touched' === l.level);
    expect(touched).toMatchObject({ covered: 2, total: 2, pct: 100 });
    expect(second.levels.find((l) => 'proved' === l.level)).toMatchObject({
      covered: 1,
      missing: ['a'],
    });
  });

  it('says the executed level is unmeasured when no driven browser can report code', async () => {
    const { fs } = createMemoryFs();
    const report = await foldAppCoverage({
      now: () => 0,
      fs,
      reticleRoot: '/p/.reticle',
      seen: [],
      session: session([], []),
    });
    expect(report.note).toMatch(/executed/);
  });

  it('folds code coverage when the driven browser reports it', async () => {
    const { fs } = createMemoryFs();
    const report = await foldAppCoverage({
      now: () => 0,
      fs,
      reticleRoot: '/p/.reticle',
      seen: [],
      session: session([], []),
      takeCode: () =>
        Promise.resolve([
          {
            url: 'http://h/src/Cart.tsx',
            functions: [
              { functionName: 'pay', ranges: [{ startOffset: 5, endOffset: 9, count: 0 }] },
            ],
          },
        ]),
    });
    expect(report.note).toBeUndefined();
    expect(report.levels.find((l) => 'executed' === l.level)).toMatchObject({
      covered: 0,
      missing: ['src/Cart.tsx: pay'],
    });
  });
});

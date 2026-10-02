import { describe, expect, it } from 'vitest';
import { foldAssetNoise } from './asset-noise.js';

/**
 * The dev server's own traffic, which is most of what `reticle_network` returns and none of what
 * anybody asked about.
 *
 * Measured on a connected drive of the bench app: 200 calls, 28,408 bytes, mean 142 bytes each,
 * and 68% of those bytes were URLs like `/src/main.tsx` and `/node_modules/.vite/deps/react.js`.
 * Zero of them carried a body. They are not evidence of anything an agent is verifying; they are
 * the bundler talking to itself, and an agent pays for every one on every read.
 *
 * Folding them is a ROUTE cut: the count, the byte total and a sample survive, and one named
 * argument brings every row back. The line this must not cross is the one `lean` crossed — dropping
 * evidence to save tokens, which cost that profile two of five fixes and produced this project's
 * first measured false green. So a FAILED asset stays listed (a 404 on a chunk is a real defect),
 * and nothing folds at all once the caller's filter shows they are asking about specific calls.
 */
const asset = (url: string, status = 200) => ({ method: 'GET', url, status });

describe('foldAssetNoise', () => {
  it('folds successful dev-server asset GETs into a count, keeping everything else', () => {
    const calls = [
      asset('http://localhost:4312/src/main.tsx'),
      asset('http://localhost:4312/@vite/client'),
      asset('http://localhost:4312/node_modules/.vite/deps/react.js'),
      { method: 'POST', url: 'http://localhost:4312/api/todos', status: 201 },
    ];
    const r = foldAssetNoise(calls, { folding: true });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.url).toContain('/api/todos');
    expect(r.folded?.count).toBe(3);
  });

  it('KEEPS a failed asset — a 404 on a chunk is a real defect, not noise', () => {
    const calls = [asset('/src/main.tsx', 404), asset('/@vite/client', 200)];
    const r = foldAssetNoise(calls, { folding: true });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.status).toBe(404);
    expect(r.folded?.count).toBe(1);
  });

  it('folds NOTHING when the caller named calls — a filter means they are asking', () => {
    const calls = [asset('/src/main.tsx'), asset('/@vite/client')];
    const r = foldAssetNoise(calls, { folding: false });
    expect(r.calls).toHaveLength(2);
    expect(r.folded).toBeUndefined();
  });

  it('says how to get the folded rows back, and shows a sample', () => {
    // A saving the reader cannot see or undo is a silent capability, which is the failure this
    // project has already paid for once.
    const calls = Array.from({ length: 9 }, (_, i) => asset(`/src/c${String(i)}.tsx`));
    const r = foldAssetNoise(calls, { folding: true });
    expect(r.folded?.count).toBe(9);
    expect(r.folded?.sample.length).toBeLessThanOrEqual(3);
    expect(r.folded?.how).toMatch(/assets/i);
    expect(r.folded?.bytes).toBeGreaterThan(0);
  });

  it('reports nothing when there was no noise to fold', () => {
    const r = foldAssetNoise([{ method: 'GET', url: '/api/health', status: 200 }], {
      folding: true,
    });
    expect(r.calls).toHaveLength(1);
    expect(r.folded).toBeUndefined();
  });
});

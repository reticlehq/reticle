import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { diffPng } from './visual-diff.js';

/** A solid-color PNG as raw bytes (the on-disk baseline format). */
function solid(w: number, h: number, rgba: [number, number, number, number]): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** A white PNG with one pixel painted at (x,y). */
function withDot(w: number, h: number, x: number, y: number): Uint8Array {
  const png = new PNG({ width: w, height: h });
  png.data.fill(255); // opaque white
  const i = (y * w + x) * 4;
  png.data[i] = 0;
  png.data[i + 1] = 0;
  png.data[i + 2] = 0;
  return new Uint8Array(PNG.sync.write(png));
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

describe('diffPng', () => {
  it('1: identical images match with zero changed pixels', async () => {
    const a = solid(8, 8, WHITE);
    const r = await diffPng(a, solid(8, 8, WHITE));
    expect(r.matched).toBe(true);
    expect(r.changedPixels).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.dimensionMismatch).toBe(false);
    expect(r.region).toBeUndefined();
    expect(r.diffPng).toBeDefined();
  });

  it('2: a single changed pixel fails and reports a 1×1 region', async () => {
    const r = await diffPng(solid(8, 8, WHITE), withDot(8, 8, 3, 5));
    expect(r.matched).toBe(false);
    expect(r.changedPixels).toBe(1);
    expect(r.region).toEqual({ x: 3, y: 5, width: 1, height: 1 });
  });

  it('3: a mask over the changed region neutralizes the diff', async () => {
    const r = await diffPng(solid(8, 8, WHITE), withDot(8, 8, 3, 5), {
      masks: [{ x: 2, y: 4, width: 3, height: 3 }],
    });
    expect(r.changedPixels).toBe(0);
    expect(r.matched).toBe(true);
  });

  it('4: maxRatio tolerates a small change', async () => {
    const total = 64;
    const r = await diffPng(solid(8, 8, WHITE), withDot(8, 8, 0, 0), { maxRatio: 1 / total });
    expect(r.changedPixels).toBe(1);
    expect(r.matched).toBe(true); // 1/64 ≤ maxRatio
  });

  it('5: a dimension mismatch is a hard fail with no diff image', async () => {
    const r = await diffPng(solid(8, 8, WHITE), solid(10, 8, WHITE));
    expect(r.dimensionMismatch).toBe(true);
    expect(r.matched).toBe(false);
    expect(r.diffPng).toBeUndefined();
    expect(r.baseline).toEqual({ width: 8, height: 8 });
    expect(r.current).toEqual({ width: 10, height: 8 });
  });
});

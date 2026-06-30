import { VISUAL_PIXEL_THRESHOLD } from '@reticlehq/protocol';

/** A rectangle in image pixel space — a mask to ignore, or the bounding box of what changed. */
export interface VisualRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Knobs for a perceptual diff. masks zero out volatile regions (clocks, avatars) before comparing. */
export interface DiffOptions {
  /** pixelmatch per-pixel color threshold (0..1; higher = more lenient). */
  threshold?: number;
  /** A run passes when changed/total ≤ maxRatio. Default 0 (any change fails). */
  maxRatio?: number;
  /** Regions to neutralize in BOTH images before diffing, so dynamic content never trips the diff. */
  masks?: VisualRect[];
}

/** The verdict of a perceptual diff (also the reticle_visual_diff result body). */
export interface VisualDiffResult {
  matched: boolean;
  changedPixels: number;
  totalPixels: number;
  /** changedPixels / totalPixels (0 on a dimension mismatch). */
  ratio: number;
  width: number;
  height: number;
  /** True when baseline and current differ in size — a pixel diff is impossible, so it's a fail. */
  dimensionMismatch: boolean;
  baseline: { width: number; height: number };
  current: { width: number; height: number };
  /** Bounding box of the changed pixels (omitted when nothing changed / dimension mismatch). */
  region?: VisualRect;
  /** Encoded overlay diff PNG (omitted on a dimension mismatch). */
  diffPng?: Uint8Array;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

interface PngModule {
  PNG: {
    sync: { read(buf: Buffer): DecodedPng; write(png: { data: Buffer }): Buffer };
    new (opts: { width: number; height: number }): { data: Buffer };
  };
}

/** The pixelmatch signature — named so loadDeps' return type avoids a top-level value import. */
type PixelmatchFn = (
  a: Uint8Array,
  b: Uint8Array,
  out: Uint8Array | null,
  w: number,
  h: number,
  opts?: { threshold?: number },
) => number;

/** Lazy load — pngjs/pixelmatch are optional deps, so the always-on path never imports them. */
async function loadDeps(): Promise<{ PNG: PngModule['PNG']; pixelmatch: PixelmatchFn }> {
  const png = (await import('pngjs')) as unknown as PngModule;
  const pm = (await import('pixelmatch')) as unknown as { default: PixelmatchFn };
  return { PNG: png.PNG, pixelmatch: pm.default };
}

const RGBA = 4;

/** Zero a rectangle (clamped to bounds) in an RGBA buffer so masked regions compare equal. */
function applyMask(data: Buffer, width: number, height: number, rect: VisualRect): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(height, Math.floor(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * RGBA;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
}

/** Bounding box of pixelmatch's red diff pixels in the overlay output (undefined if none). */
function changedRegion(out: Buffer, width: number, height: number): VisualRect | undefined {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * RGBA;
      // pixelmatch marks a changed pixel solid red (default diffColor) at full alpha.
      if (out[i] === 255 && out[i + 1] === 0 && out[i + 2] === 0 && out[i + 3] === 255) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Perceptually diff two PNGs. Pure (deps injected by lazy import), no IO. A size
 * mismatch is a hard fail (can't pixel-diff) reported as `dimensionMismatch`, never a throw.
 */
export async function diffPng(
  baselineBytes: Uint8Array,
  currentBytes: Uint8Array,
  opts: DiffOptions = {},
): Promise<VisualDiffResult> {
  const { PNG, pixelmatch } = await loadDeps();
  const a = PNG.sync.read(Buffer.from(baselineBytes));
  const b = PNG.sync.read(Buffer.from(currentBytes));
  const baseDims = { width: a.width, height: a.height };
  const curDims = { width: b.width, height: b.height };

  if (a.width !== b.width || a.height !== b.height) {
    return {
      matched: false,
      changedPixels: 0,
      totalPixels: a.width * a.height,
      ratio: 0,
      width: a.width,
      height: a.height,
      dimensionMismatch: true,
      baseline: baseDims,
      current: curDims,
    };
  }

  const { width, height } = a;
  for (const rect of opts.masks ?? []) {
    applyMask(a.data, width, height, rect);
    applyMask(b.data, width, height, rect);
  }

  const out = new PNG({ width, height });
  const threshold = opts.threshold ?? VISUAL_PIXEL_THRESHOLD;
  const changedPixels = pixelmatch(a.data, b.data, out.data, width, height, { threshold });
  const totalPixels = width * height;
  const ratio = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  const maxRatio = opts.maxRatio ?? 0;

  const region = changedPixels > 0 ? changedRegion(out.data, width, height) : undefined;
  const result: VisualDiffResult = {
    matched: ratio <= maxRatio,
    changedPixels,
    totalPixels,
    ratio,
    width,
    height,
    dimensionMismatch: false,
    baseline: baseDims,
    current: curDims,
    diffPng: new Uint8Array(PNG.sync.write(out)),
  };
  return region === undefined ? result : { ...result, region };
}

import { CanvasTrigger, EventType } from '@reticlehq/core';

export { CanvasTrigger };
import { refs } from '@/dom/addressing/refs.js';
import { nativeSetInterval } from '@/timers/native/native-timers.js';
import { observeSafely, observeValue, type Emit, type Teardown } from './types.js';

/**
 * What each `<canvas>` shows, as a `CANVAS_DIGEST` when it changes.
 *
 * Canvas pixels never reach the DOM, so a canvas app that drew the wrong colour looked, to a
 * recording, exactly like one that drew the right one. Every POLL_MS each canvas (at most
 * MAX_CANVASES) is drawn down to a SIDE x SIDE sample, hashed, and reported only when the hash
 * changed. Cheap and bounded: 256 pixels per canvas, no image leaves the page, only a hash and a
 * mean colour. A canvas that cannot be read (cross-origin pixels, a WebGL buffer already cleared)
 * reports nothing rather than a false digest.
 */
const SIDE = 16;
const POLL_MS = 500;
const MAX_CANVASES = 4;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** Channels are bucketed to 32 levels, so a sub-pixel antialiasing wobble is not a change. */
const QUANTUM = 8;

export interface CanvasSample {
  /** SIDE x SIDE RGBA pixels. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A hash of the sample and its mean colour. Pure. */
export function digestPixels(data: Uint8ClampedArray): {
  digest: string;
  mean: [number, number, number];
} {
  let hash = FNV_OFFSET;
  const sum = [0, 0, 0];
  const pixels = Math.max(1, data.length / 4);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const value = data[i + c] ?? 0;
      sum[c] = (sum[c] ?? 0) + value;
      hash = Math.imul(hash ^ Math.floor(value / QUANTUM), FNV_PRIME) >>> 0;
    }
  }
  const mean = sum.map((s) => Math.round(s / pixels)) as [number, number, number];
  return { digest: hash.toString(16).padStart(8, '0'), mean };
}

/** Draw a canvas down to SIDE x SIDE and read it, or undefined when its pixels cannot be read. */
function sampleCanvas(canvas: HTMLCanvasElement): CanvasSample | undefined {
  if (0 === canvas.width || 0 === canvas.height) return undefined;
  const scratch = document.createElement('canvas');
  scratch.width = SIDE;
  scratch.height = SIDE;
  const ctx = scratch.getContext('2d');
  if (null === ctx) return undefined;
  // Throws on a cross-origin (tainted) canvas: that canvas is simply not reported.
  const data = observeValue(() => {
    ctx.drawImage(canvas, 0, 0, SIDE, SIDE);
    return ctx.getImageData(0, 0, SIDE, SIDE).data;
  });
  return data === undefined ? undefined : { data, width: canvas.width, height: canvas.height };
}

interface CanvasOptions {
  /** Injected for the tests; jsdom has no 2D context. */
  sample?: (canvas: HTMLCanvasElement) => CanvasSample | undefined;
  every?: (run: () => void, ms: number) => () => void;
}

/** The installed observer's sampler, for `canvasAfterAct`. One page, one observer. */
let sampleAll: ((trigger: CanvasTrigger) => void) | undefined;

/**
 * Sample every canvas at the end of an act, sent even when nothing changed: a click that drew
 * nothing is the finding. Called before the act answers, so the event falls in the act's window
 * and is attributed to it. Does nothing when the observer is not installed.
 */
export function canvasAfterAct(): void {
  sampleAll?.(CanvasTrigger.ACT);
}

export function installCanvas(emit: Emit, opts: CanvasOptions = {}): Teardown {
  const sample = opts.sample ?? sampleCanvas;
  const every = opts.every ?? nativeSetInterval;
  const last = new WeakMap<HTMLCanvasElement, string>();
  const look = (trigger: CanvasTrigger): void => {
    observeSafely(() => {
      const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, MAX_CANVASES);
      for (const canvas of canvases) {
        const read = sample(canvas);
        if (read === undefined) continue;
        const { digest, mean } = digestPixels(read.data);
        if (CanvasTrigger.POLL === trigger && last.get(canvas) === digest) continue;
        last.set(canvas, digest);
        emit(
          EventType.CANVAS_DIGEST,
          { digest, width: read.width, height: read.height, mean, trigger },
          refs.refFor(canvas),
        );
      }
    });
  };
  sampleAll = look;
  const stop = every(() => look(CanvasTrigger.POLL), POLL_MS);
  return () => {
    stop();
    if (sampleAll === look) sampleAll = undefined;
  };
}

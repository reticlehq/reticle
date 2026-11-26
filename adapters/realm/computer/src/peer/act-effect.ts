/**
 * What an action left that the realm can see, beside the elements: the pixels, the settings, the
 * clipboard and the disk.
 */
import type { ActOutcome } from '../driver.js';

/** The pixels in the answer: what changed, and what moved by itself and cannot be read. */
export function pixelEffect({ pixels }: ActOutcome): Record<string, number> {
  const moving = 0 < (pixels?.moving ?? 0) ? { pixelsMovingByItself: pixels?.moving ?? 0 } : {};
  return pixels === undefined ? {} : { pixelsChanged: pixels.changed, ...moving };
}

/** True when an action left nothing that this realm can see. */
export function sawNothing(outcome: ActOutcome, changesOnScreen: number): boolean {
  return (
    0 === changesOnScreen &&
    0 === (outcome.settingsChanged ?? []).length &&
    true !== outcome.clipboardChanged &&
    !((outcome.pixels?.changed ?? 0) > 0) &&
    0 === (outcome.bytesWritten ?? 0)
  );
}

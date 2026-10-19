/**
 * What a canvas shows, as a digest.
 *
 * Canvas pixels never reach the DOM, so a canvas app that drew the wrong colour looked, to a
 * recording, exactly like one that drew the right one.
 */
import { describe, expect, it } from 'vitest';
import { EventType, ReticleCommand } from '@reticlehq/core';
import { createCommandRegistry } from '@/commands/commands.js';
import { refs } from '@/dom/addressing/refs.js';
import { CanvasTrigger, digestPixels, installCanvas, type CanvasSample } from './canvas.js';

const solid = (r: number, g: number, b: number): CanvasSample => {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { data, width: 300, height: 150 };
};

describe('the canvas digest', () => {
  it('is the same for the same pixels and different for a different colour', () => {
    const red = digestPixels(solid(255, 0, 0).data);
    expect(digestPixels(solid(255, 0, 0).data)).toEqual(red);
    expect(digestPixels(solid(0, 0, 255).data).digest).not.toBe(red.digest);
    expect(red.mean).toEqual([255, 0, 0]);
  });

  it('emits only when what a canvas shows changes, and stands down where nothing can be read', () => {
    document.body.innerHTML = '<canvas></canvas><canvas></canvas>';
    let frame = solid(255, 0, 0);
    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    let tick: () => void = () => undefined;
    const teardown = installCanvas((type, data) => events.push({ type, data }), {
      sample: (canvas) => (canvas === document.querySelectorAll('canvas')[1] ? undefined : frame),
      every: (run) => {
        tick = run;
        return () => undefined;
      },
    });
    tick();
    tick();
    frame = solid(0, 0, 255);
    tick();
    teardown();
    expect(events.map((e) => e.type)).toEqual([EventType.CANVAS_DIGEST, EventType.CANVAS_DIGEST]);
    expect(events[1]?.data).toMatchObject({
      width: 300,
      height: 150,
      mean: [0, 0, 255],
      trigger: CanvasTrigger.POLL,
    });
  });
});

/*
 * A digest on a 500 ms timer is not tied to the action that caused it: the frame a click drew could
 * land in the next timer tick, after another action. So an act ends with its own sample, sent even
 * when nothing changed (a click that drew nothing is the finding), inside the act's window.
 */
describe('the canvas digest after an act', () => {
  it('samples every canvas when an act settles, before the act answers', async () => {
    document.body.innerHTML = '<button>Draw</button><canvas></canvas>';
    let frame = solid(255, 0, 0);
    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    const teardown = installCanvas((type, data) => events.push({ type, data }), {
      sample: () => frame,
      every: () => () => undefined,
    });
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      frame = solid(0, 255, 0);
    });
    const act = createCommandRegistry().get(ReticleCommand.ACT);
    if (act === undefined) throw new Error('no act handler');
    await act({ ref: refs.refFor(button), action: 'click' });
    // A second act that draws nothing still reports what the canvas shows.
    await act({ ref: refs.refFor(button), action: 'click' });
    teardown();
    const digests = events.filter((e) => EventType.CANVAS_DIGEST === e.type);
    expect(digests.map((e) => [e.data['trigger'], e.data['mean']])).toEqual([
      [CanvasTrigger.ACT, [0, 255, 0]],
      [CanvasTrigger.ACT, [0, 255, 0]],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  BlindSpotKind,
  CanvasTrigger,
  ContradictionKind,
  EventType,
  type ReticleEvent,
} from '@reticlehq/core';
import { StateRender, findContradictions, readStateRender } from './contradictions.js';
import { CANVAS_QUIET_MS, CanvasPaint, canvasPaint } from './contradiction-evidence.js';
import { buildCoverageStatement, canvasPaintSpots } from '../evidence/blind-spots.js';

/**
 * A canvas repaint is the screen moving (#1525).
 *
 * In a canvas app (an editor, a chart, a game) a correct state change makes no DOM mutation, so
 * `state-vs-render` fired on every click and no state-changing action could get a `yes`. The SDK
 * already sends `CANVAS_DIGEST`: on its poll when the digest changed, and at the end of each act. A
 * digest is a paint when it differs from the last digest of the same canvas.
 */
let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}, ref?: string): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data, ...(ref === undefined ? {} : { ref }) };
}
const stateChanged = (): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { store: 'board', path: 'count' });
const domChanged = (): ReticleEvent =>
  ev(EventType.DOM_TEXT, { text: 'Count: 1', old: 'Count: 0' });
const digest = (value: string, trigger: CanvasTrigger, ref = 'e7'): ReticleEvent =>
  ev(
    EventType.CANVAS_DIGEST,
    { digest: value, width: 300, height: 150, mean: [200, 200, 200], trigger },
    ref,
  );
const caused = (events: ReticleEvent[], prior: ReticleEvent[] = []): string[] =>
  findContradictions(events, { actionSince: 0, prior }).map((c) => c.kind);

describe('state-vs-render on a canvas-rendered app', () => {
  const before = [digest('aaaa0001', CanvasTrigger.POLL)];

  it('does not fire when the act digest differs from the canvas digest before the action', () => {
    const window = [stateChanged(), digest('bbbb0002', CanvasTrigger.ACT)];
    expect(caused(window, before)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(canvasPaintSpots(window, { actionSince: 0, prior: before })).toEqual([]);
  });

  it('does not fire when a poll inside the window reported a changed canvas', () => {
    const window = [stateChanged(), digest('bbbb0002', CanvasTrigger.POLL)];
    expect(caused(window, before)).not.toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('does not read the first digest of a canvas as a paint: nothing says what it showed before', () => {
    // A poll for a canvas the SDK had not sampled yet, or a canvas mounted in the window.
    expect(canvasPaint([digest('bbbb0002', CanvasTrigger.POLL)], [], 0)).toBe(
      CanvasPaint.UNOBSERVED,
    );
    expect(caused([stateChanged(), digest('bbbb0002', CanvasTrigger.POLL)])).not.toContain(
      ContradictionKind.STATE_VS_RENDER,
    );
  });

  it('does not fire when the canvas changed between two digests inside the window', () => {
    const window = [
      digest('aaaa0001', CanvasTrigger.ACT),
      stateChanged(),
      digest('bbbb0002', CanvasTrigger.ACT),
    ];
    expect(caused(window)).not.toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('abstains, and names the gap, when a canvas is on screen and no change on it was seen', () => {
    // Same digest as before: the 16x16 sample can miss a small repaint, and WebGL can read blank.
    const window = [stateChanged(), digest('aaaa0001', CanvasTrigger.ACT)];
    expect(caused(window, before)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(readStateRender(window, { actionSince: 0, prior: before })).toBe(
      StateRender.CANVAS_UNOBSERVED,
    );
    const spots = canvasPaintSpots(window, { actionSince: 0, prior: before });
    expect(spots).toEqual([{ kind: BlindSpotKind.CANVAS_PAINT_UNOBSERVED, count: 1 }]);
    expect(buildCoverageStatement(spots).note).toContain('canvas paint not observed');
  });

  it('abstains when the act digest has no earlier digest to compare with', () => {
    const window = [stateChanged(), digest('aaaa0001', CanvasTrigger.ACT)];
    expect(canvasPaint(window, [], 0)).toBe(CanvasPaint.UNOBSERVED);
    expect(caused(window)).not.toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('compares each canvas with its own earlier digest, not with another canvas', () => {
    const prior = [
      digest('aaaa0001', CanvasTrigger.POLL, 'e1'),
      digest('cccc0003', CanvasTrigger.POLL, 'e2'),
    ];
    // Canvas e2 now shows what e1 showed before: e2 changed, so the screen moved.
    expect(canvasPaint([digest('aaaa0001', CanvasTrigger.ACT, 'e2')], prior, 0)).toBe(
      CanvasPaint.PAINTED,
    );
    // Both show what they showed before: nothing was seen to change.
    const same = [
      digest('aaaa0001', CanvasTrigger.ACT, 'e1'),
      digest('cccc0003', CanvasTrigger.ACT, 'e2'),
    ];
    expect(canvasPaint(same, prior, 0)).toBe(CanvasPaint.UNOBSERVED);
    expect(canvasPaintSpots([stateChanged(), ...same], { actionSince: 0, prior })).toEqual([
      { kind: BlindSpotKind.CANVAS_PAINT_UNOBSERVED, count: 2 },
    ]);
  });

  it('reads a digest from an SDK older than the trigger field as an act digest', () => {
    const old = ev(
      EventType.CANVAS_DIGEST,
      { digest: 'aaaa0001', width: 1, height: 1, mean: [0, 0, 0] },
      'e7',
    );
    expect(canvasPaint([old], before, 0)).toBe(CanvasPaint.UNOBSERVED);
    const changed = ev(
      EventType.CANVAS_DIGEST,
      { digest: 'bbbb0002', width: 1, height: 1, mean: [0, 0, 0] },
      'e7',
    );
    expect(canvasPaint([changed], before, 0)).toBe(CanvasPaint.PAINTED);
  });

  it('ignores a digest from before the window when nothing in the window carries one', () => {
    expect(canvasPaint([stateChanged()], before, 0)).toBe(CanvasPaint.NONE);
  });
});

describe('state-vs-render where no canvas is involved', () => {
  it('still fires on a DOM app that did not re-render', () => {
    expect(caused([stateChanged()])).toContain(ContradictionKind.STATE_VS_RENDER);
    expect(canvasPaintSpots([stateChanged()], { actionSince: 0 })).toEqual([]);
  });

  it('still fires when the only canvas digest is from before the window', () => {
    expect(caused([stateChanged()], [digest('aaaa0001', CanvasTrigger.POLL)])).toContain(
      ContradictionKind.STATE_VS_RENDER,
    );
  });

  it('names no canvas gap when the DOM moved, nothing changed in state, or nothing was attributed', () => {
    const same = digest('aaaa0001', CanvasTrigger.ACT);
    const prior = [digest('aaaa0001', CanvasTrigger.POLL)];
    expect(
      canvasPaintSpots([stateChanged(), domChanged(), same], { actionSince: 0, prior }),
    ).toEqual([]);
    expect(canvasPaintSpots([same], { actionSince: 0, prior })).toEqual([]);
    expect(canvasPaintSpots([stateChanged(), same], { prior })).toEqual([]);
  });

  it('names no canvas gap when the window carries a request, which another rule owns', () => {
    const call = ev(EventType.NET_REQUEST, {
      id: 'n1',
      method: 'POST',
      url: '/api/x',
      status: 200,
      ok: true,
    });
    const prior = [digest('aaaa0001', CanvasTrigger.POLL)];
    expect(
      canvasPaintSpots([stateChanged(), call, digest('aaaa0001', CanvasTrigger.ACT)], {
        actionSince: 0,
        prior,
      }),
    ).toEqual([]);
  });
});

/** A digest at a given time, so a test can place it before or after the action. */
const at = (
  t: number,
  value: string,
  data: Record<string, unknown> = {},
  ref = 'e7',
): ReticleEvent => ({
  t,
  seq: t,
  type: EventType.CANVAS_DIGEST,
  sessionId: 's',
  ref,
  data: {
    digest: value,
    width: 64,
    height: 64,
    mean: [0, 0, 0],
    trigger: CanvasTrigger.POLL,
    ...data,
  },
});
const stateAt = (t: number): ReticleEvent => ({
  t,
  seq: t,
  type: EventType.STATE_CHANGE,
  sessionId: 's',
  data: { store: 'board', path: 'count' },
});
const ACT_AT = 5_000;
const causedAt = (events: ReticleEvent[], prior: ReticleEvent[]): string[] =>
  findContradictions(events, { actionSince: ACT_AT, prior }).map((c) => c.kind);

/**
 * Only a canvas that could carry the render counts (review of #1525). A canvas that is hidden, or
 * that was already changing before the action, says nothing about what the action rendered, and it
 * must not hide a DOM app that did not re-render.
 */
describe('a canvas that is not the render', () => {
  it('ignores a hidden canvas: a stale DOM app beside it still raises state-vs-render', () => {
    const hidden = { visible: false };
    const prior = [at(ACT_AT - 3_000, 'aaaa0001', hidden)];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'aaaa0001', { ...hidden, trigger: CanvasTrigger.ACT }),
    ];
    expect(causedAt(window, prior)).toContain(ContradictionKind.STATE_VS_RENDER);
    expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([]);
  });

  it('ignores a hidden canvas even when its digest changed', () => {
    const hidden = { visible: false };
    const prior = [at(ACT_AT - 3_000, 'aaaa0001', hidden)];
    expect(canvasPaint([at(ACT_AT + 10, 'bbbb0002', hidden)], prior, ACT_AT)).toBe(
      CanvasPaint.NONE,
    );
  });

  it('reads a canvas the click scrolled into view and redrew as the render', () => {
    // The chart opened below the fold: its last sample before the click was off screen.
    const prior = [at(ACT_AT - 1_200, 'aaaa0001', { visible: false })];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'bbbb0002', { trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.PAINTED);
    expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([]);
  });

  it('does not read a redraw as the render when the canvas went off screen for it', () => {
    const prior = [at(ACT_AT - 3_000, 'aaaa0001')];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'bbbb0002', { visible: false, trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.NONE);
    expect(causedAt(window, prior)).toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('counts only the visible canvases on the coverage line', () => {
    const prior = [
      at(ACT_AT - 3_000, 'aaaa0001', {}, 'e1'),
      at(ACT_AT - 3_000, 'cccc0003', { visible: false }, 'e2'),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'aaaa0001', { trigger: CanvasTrigger.ACT }, 'e1'),
      at(ACT_AT + 10, 'cccc0003', { visible: false, trigger: CanvasTrigger.ACT }, 'e2'),
    ];
    expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([
      { kind: BlindSpotKind.CANVAS_PAINT_UNOBSERVED, count: 1 },
    ]);
  });

  it('does not read a change on a canvas that was already changing as the render', () => {
    // A spinner: the poll reports a new digest every 500 ms before the action and after it.
    const prior = [
      at(ACT_AT - 1_500, 'aaaa0001'),
      at(ACT_AT - 1_000, 'bbbb0002'),
      at(ACT_AT - 500, 'cccc0003'),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'dddd0004', { trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.UNOBSERVED);
    // Not a silent clear: the rule abstains, and the coverage line says why.
    expect(causedAt(window, prior)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([
      { kind: BlindSpotKind.CANVAS_PAINT_UNOBSERVED, count: 1 },
    ]);
  });

  it('keeps an animation that goes on changing inside the window unobserved', () => {
    const prior = [at(ACT_AT - 900, 'aaaa0001'), at(ACT_AT - 400, 'bbbb0002')];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 100, 'cccc0003'),
      at(ACT_AT + 600, 'dddd0004'),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.UNOBSERVED);
  });

  it('reads a change on a canvas that last changed well before the action as the render', () => {
    // The earlier change was an earlier click's render: the act's own digest found it.
    const prior = [
      at(ACT_AT - 4_000, 'aaaa0001'),
      at(ACT_AT - 3_000, 'bbbb0002', { trigger: CanvasTrigger.ACT }),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'cccc0003', { trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.PAINTED);
    expect(causedAt(window, prior)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([]);
  });

  it('still reads the render on a steady canvas beside an animated one', () => {
    const prior = [
      at(ACT_AT - 4_000, 'aaaa0001', {}, 'chart'),
      at(ACT_AT - 1_000, 'bbbb0002', {}, 'spinner'),
      at(ACT_AT - 500, 'cccc0003', {}, 'spinner'),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'dddd0004', {}, 'spinner'),
      at(ACT_AT + 10, 'eeee0005', { trigger: CanvasTrigger.ACT }, 'chart'),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.PAINTED);
  });
});

/**
 * A canvas on a timer slower than `CANVAS_STEADY_MS` (a dashboard chart, a clock, a ticker): its
 * last change is seconds old, and its next tick can land in the window (review of #1525).
 */
describe('a canvas that refreshes on a timer', () => {
  it.each([2_000, 3_000, 5_000, 9_000])(
    'does not read a tick every %i ms as the render beside a stale DOM',
    (every) => {
      const prior = [
        at(ACT_AT - 2 * every - 100, 'aaaa0001', {}, 'chart'),
        at(ACT_AT - every - 100, 'bbbb0002', {}, 'chart'),
      ];
      const window = [stateAt(ACT_AT + 5), at(ACT_AT + 400, 'cccc0003', {}, 'chart')];
      expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.UNOBSERVED);
      expect(causedAt(window, prior)).not.toContain(ContradictionKind.STATE_VS_RENDER);
      expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([
        { kind: BlindSpotKind.CANVAS_PAINT_UNOBSERVED, count: 1 },
      ]);
    },
  );

  it('does not read the act digest as the render either, when the tick landed in the act', () => {
    const prior = [at(ACT_AT - 4_100, 'aaaa0001'), at(ACT_AT - 2_100, 'bbbb0002')];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'cccc0003', { trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.UNOBSERVED);
  });

  it('reads the render on a canvas whose last change on its own is older than CANVAS_QUIET_MS', () => {
    const prior = [
      at(ACT_AT - CANVAS_QUIET_MS - 2_000, 'aaaa0001'),
      at(ACT_AT - CANVAS_QUIET_MS - 1_000, 'bbbb0002'),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'cccc0003', { trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.PAINTED);
  });

  it('pins the limit: a timer slower than CANVAS_QUIET_MS still reads as the render', () => {
    const every = CANVAS_QUIET_MS + 5_000;
    const prior = [at(ACT_AT - 2 * every - 100, 'aaaa0001'), at(ACT_AT - every - 100, 'bbbb0002')];
    const window = [stateAt(ACT_AT + 5), at(ACT_AT + 400, 'cccc0003')];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.PAINTED);
    expect(causedAt(window, prior)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(canvasPaintSpots(window, { actionSince: ACT_AT, prior })).toEqual([]);
  });

  it('does not count a redraw the poll found just after an act as a change on its own', () => {
    // An earlier click drew on the next animation frame: the act digest was taken first, and the
    // poll found the new picture 300 ms later.
    const prior = [
      at(ACT_AT - 5_000, 'aaaa0001', { trigger: CanvasTrigger.ACT }),
      at(ACT_AT - 4_700, 'bbbb0002'),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'cccc0003', { trigger: CanvasTrigger.ACT }),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.PAINTED);
  });

  it('keeps a canvas that changes on its own from hiding behind another canvas', () => {
    const prior = [
      at(ACT_AT - 6_000, 'aaaa0001', {}, 'clock'),
      at(ACT_AT - 3_000, 'bbbb0002', {}, 'clock'),
      at(ACT_AT - 6_000, 'cccc0003', {}, 'chart'),
    ];
    const window = [
      stateAt(ACT_AT + 5),
      at(ACT_AT + 10, 'cccc0003', { trigger: CanvasTrigger.ACT }, 'chart'),
      at(ACT_AT + 10, 'dddd0004', { trigger: CanvasTrigger.ACT }, 'clock'),
    ];
    expect(canvasPaint(window, prior, ACT_AT)).toBe(CanvasPaint.UNOBSERVED);
  });
});

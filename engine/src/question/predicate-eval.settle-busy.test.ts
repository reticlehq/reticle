/**
 * Some of an app's work never touches the network or the DOM until it is done: a debounced save, a
 * worker, a reply over a socket. Only the app knows it is busy, so it says so (`reticle.busy(work)`),
 * and `settled` counts that work as in flight until it ends, the way it counts a request.
 */

import { describe, expect, it } from 'vitest';
import { EventType, PredicateKind, RETICLE_BUSY_SIGNAL, SettledChannel } from '@reticlehq/core';
import { evalSettled } from './predicate/predicate-eval.js';
import type { ReticleEvent } from '@reticlehq/core';

const settled = { kind: PredicateKind.SETTLED } as const;
const busy = (t: number, delta: number): ReticleEvent =>
  ({
    type: EventType.SIGNAL,
    t,
    seq: t,
    data: { name: RETICLE_BUSY_SIGNAL, data: { delta } },
  }) as unknown as ReticleEvent;

describe('settled, with work the app declared', () => {
  it('is not settled while the app says it is busy, however quiet the page is', () => {
    const r = evalSettled([busy(100, 1)], settled, 5000);
    expect(r.pass).toBe(false);
    expect(r.failureReason).toMatch(/1 app task\(s\) still pending/);
  });

  it('settles once that work ends and the quiet window passes', () => {
    expect(evalSettled([busy(100, 1), busy(200, -1)], settled, 5000).pass).toBe(true);
  });

  it('never counts below zero: an end whose start fell before the window is not credit', () => {
    expect(evalSettled([busy(100, -1), busy(200, 1)], settled, 5000).pass).toBe(false);
  });
});

/**
 * Framework commits are ambient on many pages (a clock re-renders every second), so the default
 * settle never counts them. An app whose commits ARE its work asks for `channel: "app"`: the default's
 * activity and every render commit, so a page still committing is not settled.
 */
describe('settled on the app channel', () => {
  const commit = (t: number): ReticleEvent =>
    ({ type: EventType.RENDER_COMMIT, t, seq: t, data: { commits: 1 } }) as unknown as ReticleEvent;

  it('waits out the render commits that the default ignores', () => {
    const events = [commit(4800)];
    expect(evalSettled(events, settled, 5000).pass).toBe(true);
    const app = { kind: PredicateKind.SETTLED, channel: SettledChannel.APP } as const;
    expect(evalSettled(events, app, 5000).pass).toBe(false);
    expect(evalSettled(events, app, 5400).pass).toBe(true);
  });
});

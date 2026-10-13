import { describe, expect, it } from 'vitest';
import { watchTransport } from './gate-harness.mjs';

// The install gate's negative control went red on Windows cells with "transport stayed available"
// while the gate's own daemon (idle shutdown off) was up: one `/status` probe that missed its
// deadline on a loaded runner marked the whole window as "bridge down". A bridge that is gone
// misses every probe; one that answered late was there.

function watchWith(results) {
  let i = 0;
  const probe = async () => (i < results.length ? results[i++] : true);
  const w = watchTransport(1, { intervalMs: 1, probe });
  const drained = async () => {
    while (i < results.length) await new Promise((r) => setTimeout(r, 2));
  };
  return { w, drained };
}

describe('watchTransport', () => {
  it('keeps the bridge up through one late probe', async () => {
    const { w, drained } = watchWith([true, false, true, true]);
    await drained();
    expect(w.stop().aliveThroughout).toBe(true);
  });

  it('keeps it up through misses that are not consecutive', async () => {
    const { w, drained } = watchWith([false, true, false, true, false, true]);
    await drained();
    expect(w.stop().aliveThroughout).toBe(true);
  });

  it('reports it down once probes miss in a row', async () => {
    const { w, drained } = watchWith([true, false, false, false, true]);
    await drained();
    expect(w.stop().aliveThroughout).toBe(false);
  });

  it('reports it down when it never answers', async () => {
    const { w, drained } = watchWith(Array(10).fill(false));
    await drained();
    expect(w.stop().aliveThroughout).toBe(false);
  });
});

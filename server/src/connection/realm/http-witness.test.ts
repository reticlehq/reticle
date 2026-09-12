import { describe, it, expect, vi } from 'vitest';
import { ChannelId, Independence, witnessDisagreement } from '@reticlehq/openreality';
import { HttpWitness } from './http-witness.js';

/**
 * The reference witness: a second vantage point that can look and cannot touch.
 *
 * Every channel a realm declares is, in the end, the subject describing itself — the DOM says the
 * DOM changed. A witness is a DIFFERENT PROCESS interrogating the world the subject acted on, which
 * is why a disagreement across it is the strongest evidence this protocol can produce: not an
 * inference, two independent observers.
 *
 * This one reads a real HTTP endpoint over the real network. Nothing is stubbed in the product path
 * — a witness that consulted a fixture would be the subject describing itself with extra steps.
 */
const okFetch = (body: unknown) =>
  vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) }),
  );

describe('HttpWitness', () => {
  it('cannot act — it is a Realm minus dispatch and locate', () => {
    const w: Record<string, unknown> = new HttpWitness({
      url: 'http://api.test/orders',
      fetch: okFetch([]),
      now: () => 0,
    }) as never;
    expect(w['dispatch']).toBeUndefined();
    expect(w['locate']).toBeUndefined();
    expect(w['perform']).toBeUndefined();
  });

  it('declares itself INDEPENDENT — that is the whole reason to ask it', () => {
    const w = new HttpWitness({
      url: 'http://api.test/o',
      fetch: okFetch([]),
      now: () => 0,
    });
    for (const channel of w.channels()) {
      expect(channel.independence).toBe(Independence.INDEPENDENT);
    }
  });

  it('reports what it saw, on the net channel', async () => {
    const w = new HttpWitness({
      url: 'http://api.test/o',
      fetch: okFetch([{ id: 1 }]),
      now: () => 7,
    });
    const observed = await w.observe(w.openWindow(1000));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.channel).toBe(ChannelId.NET);
    expect(observed[0]?.summary).toContain('200');
  });

  it('a UI claiming success that this witness cannot corroborate is a DISAGREEMENT', async () => {
    const w = new HttpWitness({
      url: 'http://api.test/o',
      fetch: vi.fn(() =>
        Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') }),
      ),
      now: () => 0,
    });
    const win = w.openWindow(1000);
    const found = witnessDisagreement(
      { claim: 'the order was saved', channel: ChannelId.UI },
      {
        channel: ChannelId.NET,
        observed: await w.observe(win),
        blind: (await w.coverage(win)).blindSpots,
      },
    );
    expect(found, 'the UI said saved and nothing outside the app agrees').toBeDefined();
  });

  /**
   * The property that separates evidence from accusation.
   *
   * `witnessDisagreement` refuses to speak when the witness was BLIND, and reports an anomaly when
   * it LOOKED AND SAW NOTHING. Those are opposite facts wearing the same empty array, so a witness
   * that reported an unreachable endpoint as "observed nothing" would manufacture a disagreement out
   * of its own network error — and blame the app for it.
   */
  it('an unreachable endpoint is a BLIND SPOT, never evidence of absence', async () => {
    const w = new HttpWitness({
      url: 'http://api.test/o',
      fetch: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      now: () => 0,
    });
    const win = w.openWindow(1000);
    const coverage = await w.coverage(win);
    expect(coverage.blindSpots.map((b) => b.channel)).toContain(ChannelId.NET);

    const found = witnessDisagreement(
      { claim: 'the order was saved', channel: ChannelId.UI },
      { channel: ChannelId.NET, observed: await w.observe(win), blind: coverage.blindSpots },
    );
    expect(found, 'a witness that could not look accuses nobody').toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fetchHarnessOffer, harnessOfferSource, type OfferFetch } from './harness-offer.js';
import { ReticleEnv } from '@reticlehq/core';

/**
 * The offer read exists so the HUD can advertise HONESTLY. Almost every test here is therefore about
 * answering `undefined` — "we have not heard" — because that is what stops an offline laptop from
 * advertising three free months to somebody who claimed them a month ago.
 */

const ENV = { [ReticleEnv.API_KEY]: 'rk_live_x', [ReticleEnv.CLOUD_URL]: 'https://api.test' };
const CLAIM = 'https://app.test/p/demo';

const answering = (status: number, body: string): OfferFetch =>
  vi.fn(() => Promise.resolve({ ok: 200 === status, status, text: () => Promise.resolve(body) }));

describe('reading where a workspace stands', () => {
  it('reports an unclaimed workspace, with the link that claims it', async () => {
    const offer = await fetchHarnessOffer(
      ENV,
      CLAIM,
      answering(200, JSON.stringify({ claimed: false, claimedAt: null, daysRemaining: null })),
    );
    expect(offer).toEqual({ claimed: false, claimUrl: CLAIM });
  });

  /** The platform spells "nothing" as null; the wire contract spells it as absent. */
  it('drops the platform nulls rather than passing them on as values', async () => {
    const offer = await fetchHarnessOffer(
      ENV,
      undefined,
      answering(200, JSON.stringify({ claimed: false, expiresAt: null, daysRemaining: null })),
    );
    expect(offer).toEqual({ claimed: false });
  });

  /** A lapsed claim reads `claimed:false, daysRemaining:0` — only `eligible` tells it apart. */
  it('carries whether claiming would still grant anything', async () => {
    const offer = await fetchHarnessOffer(
      ENV,
      CLAIM,
      answering(
        200,
        JSON.stringify({
          claimed: false,
          claimedAt: 1,
          expiresAt: 2,
          daysRemaining: 0,
          eligible: false,
        }),
      ),
    );
    expect(offer).toMatchObject({ claimed: false, daysRemaining: 0, eligible: false });
  });

  it('carries the remaining days of a live claim', async () => {
    const offer = await fetchHarnessOffer(
      ENV,
      CLAIM,
      answering(200, JSON.stringify({ claimed: true, expiresAt: 42, daysRemaining: 61 })),
    );
    expect(offer).toEqual({ claimed: true, expiresAt: 42, daysRemaining: 61, claimUrl: CLAIM });
  });

  it('asks the platform with the project key', async () => {
    const doFetch = answering(200, JSON.stringify({ claimed: false }));
    await fetchHarnessOffer(ENV, CLAIM, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      'https://api.test/v1/harness/offer',
      expect.objectContaining({ headers: { authorization: 'Bearer rk_live_x' } }),
    );
  });

  it.each([
    ['there is no key', {}],
    ['there is no platform', { [ReticleEnv.API_KEY]: 'rk_live_x' }],
  ])('says nothing when %s', async (_why, env) => {
    const doFetch = answering(200, JSON.stringify({ claimed: false }));
    expect(await fetchHarnessOffer(env, CLAIM, doFetch)).toBeUndefined();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the platform refuses', answering(401, '')],
    ['the body is not json', answering(200, 'not json')],
    ['the body says nothing about a claim', answering(200, '{}')],
    ['the network is gone', vi.fn(() => Promise.reject(new Error('offline'))) as OfferFetch],
  ])('says nothing when %s', async (_why, doFetch) => {
    expect(await fetchHarnessOffer(ENV, CLAIM, doFetch)).toBeUndefined();
  });

  /** A settings-shaped read must never be the reason a session hangs. */
  it('gives up rather than waiting forever', async () => {
    const hang: OfferFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    expect(await fetchHarnessOffer(ENV, CLAIM, hang, 5)).toBeUndefined();
  });
});

describe('the cache the impact snapshot reads', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * Measured in a real browser: the daemon pushes the impact snapshot the instant a session attaches,
   * and on a page nobody drives that is the only push there will ever be. Asking on the first READ
   * meant that push always carried nothing and the HUD stayed empty for the whole session.
   */
  it('asks the platform as soon as it is created, not when it is first read', () => {
    const load = vi.fn(() => Promise.resolve({ claimed: false, claimUrl: CLAIM }));
    harnessOfferSource(ENV, () => CLAIM, undefined, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('answers nothing until the first read has come back', async () => {
    const source = harnessOfferSource(
      ENV,
      () => CLAIM,
      undefined,
      () => Promise.resolve({ claimed: false, claimUrl: CLAIM }),
    );
    expect(source.read()).toBeUndefined();
    await settle();
    expect(source.read()).toEqual({ claimed: false, claimUrl: CLAIM });
  });

  /** Snapshots are built dozens of times a session; the answer changes about once per workspace. */
  it('asks once, however often it is read', async () => {
    const load = vi.fn(() => Promise.resolve({ claimed: true, daysRemaining: 60 }));
    let clock = 1_000;
    const source = harnessOfferSource(
      ENV,
      () => CLAIM,
      () => clock,
      load,
    );
    source.read();
    await settle();
    source.read();
    source.read();
    expect(load).toHaveBeenCalledTimes(1);

    clock += 11 * 60 * 1_000;
    source.read();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  /** One dropped request is not evidence that somebody un-claimed the offer. */
  it('keeps the last good answer when a refresh fails', async () => {
    let answer: Promise<{ claimed: boolean } | undefined> = Promise.resolve({ claimed: true });
    let clock = 1_000;
    const source = harnessOfferSource(
      ENV,
      () => CLAIM,
      () => clock,
      () => answer,
    );
    source.read();
    await settle();
    expect(source.read()).toEqual({ claimed: true });

    answer = Promise.resolve(undefined);
    clock += 11 * 60 * 1_000;
    source.read();
    await settle();
    expect(source.read()).toEqual({ claimed: true });
  });

  it('survives a loader that throws', async () => {
    const source = harnessOfferSource(
      ENV,
      () => CLAIM,
      undefined,
      () => Promise.reject(new Error('boom')),
    );
    expect(source.read()).toBeUndefined();
    await settle();
    expect(source.read()).toBeUndefined();
  });
});

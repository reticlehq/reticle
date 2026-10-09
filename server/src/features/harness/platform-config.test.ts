import { describe, expect, it, vi } from 'vitest';
import { fetchPlatformConfig, type ConfigFetch } from './platform-config.js';

/**
 * Every test here is about the same rule: this is a PREFERENCE, not a credential. There is no
 * failure it may turn into a thrown error, because a drive that takes tens of seconds must not be
 * stopped by a settings endpoint being slow or absent.
 */

const LINKED = { RETICLE_API_KEY: 'rk_live_x', RETICLE_CLOUD_URL: 'https://app.reticle.sh' };

const answering = (body: unknown, ok = true, status = 200): ConfigFetch =>
  vi.fn(() => Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) }));

describe('reading the driver preference from the platform', () => {
  it('returns what the platform says', async () => {
    const got = await fetchPlatformConfig(
      LINKED,
      answering({ provider: 'jev', harnessEnabled: true }),
    );
    // `providerReady` defaults TRUE when the platform reports no `available` map: silence from an
    // older API is not a refusal, the same rule the two booleans beside it follow.
    expect(got).toEqual({
      provider: 'jev',
      harnessEnabled: true,
      harnessEntitled: true,
      providerReady: true,
      platformUrl: 'https://app.reticle.sh',
    });
  });

  it('says which platform answered, so the HUD links to it rather than the hosted one', async () => {
    const got = await fetchPlatformConfig(
      { RETICLE_API_KEY: 'k', RETICLE_CLOUD_URL: 'http://localhost:4100/' },
      answering({ provider: 'jev' }),
    );
    expect(got?.platformUrl).toBe('http://localhost:4100');
  });

  it('sends the platform key as a bearer, to the config path', async () => {
    const doFetch = answering({ provider: 'jev' });
    await fetchPlatformConfig(LINKED, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      'https://app.reticle.sh/v1/model/config',
      expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer rk_live_x' } }),
    );
  });

  it('asks the hosted service when the key is set and no URL is', async () => {
    // What CI is told to set: the key, and nothing else.
    const doFetch = answering({ provider: 'jev' });
    await fetchPlatformConfig({ RETICLE_API_KEY: 'rk_live_x' }, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      'https://app.reticle.sh/v1/model/config',
      expect.objectContaining({ headers: { authorization: 'Bearer rk_live_x' } }),
    );
  });

  it('does not ask when the machine is not linked', async () => {
    const doFetch = answering({ provider: 'jev' });
    expect(await fetchPlatformConfig({}, doFetch)).toBeUndefined();
    expect(doFetch).not.toHaveBeenCalled();
  });

  /**
   * Entitlement and the switch are separate facts and must stay separate here.
   *
   * One is what a person set, the other is whether anybody is paying for the model spend. Folding
   * them would make the daemon tell somebody whose free months quietly lapsed that they had turned
   * verification off, which is a support ticket rather than an answer.
   */
  /*
   * The case the field exists for: entitled, switched on, and no key behind the provider.
   *
   * Read from `available[provider]` and not from the map as a whole -- another provider being
   * configured says nothing about whether THIS one can drive.
   */
  it("reads readiness for the project's own provider, not for any provider", async () => {
    const got = await fetchPlatformConfig(
      LINKED,
      answering({
        provider: 'jev',
        harnessEnabled: true,
        harnessEntitled: true,
        available: { jev: false, anthropic: true, openai: false },
      }),
    );
    expect(got?.providerReady).toBe(false);
  });

  it('reports entitlement apart from the switch', async () => {
    const got = await fetchPlatformConfig(
      LINKED,
      answering({ provider: 'jev', harnessEnabled: true, harnessEntitled: false }),
    );
    expect(got).toEqual({
      provider: 'jev',
      harnessEnabled: true,
      harnessEntitled: false,
      providerReady: true,
      platformUrl: 'https://app.reticle.sh',
    });
  });

  it("carries the workspace's Harness credits when the platform reports them", async () => {
    const got = await fetchPlatformConfig(
      LINKED,
      answering({ provider: 'jev', credits: { used: 12, limit: 500 } }),
    );
    expect(got?.credits).toEqual({ used: 12, limit: 500 });
  });

  /** An older API reports neither field, and silence must not read as a refusal on either. */
  it('treats a missing harnessEntitled as entitled', async () => {
    const got = await fetchPlatformConfig(LINKED, answering({ provider: 'jev' }));
    expect(got?.harnessEntitled).toBe(true);
  });

  /** The Harness is opt-in: only the platform saying it is on lets a drive spend credits. */
  it('treats a missing harnessEnabled as off', async () => {
    const got = await fetchPlatformConfig(LINKED, answering({ provider: 'jev' }));
    expect(got?.harnessEnabled).toBe(false);
  });

  it('answers nothing on a non-2xx', async () => {
    expect(await fetchPlatformConfig(LINKED, answering({}, false, 500))).toBeUndefined();
  });

  it('answers nothing when the body is not what it claims', async () => {
    const garbage: ConfigFetch = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('not json') });
    expect(await fetchPlatformConfig(LINKED, garbage)).toBeUndefined();
    expect(await fetchPlatformConfig(LINKED, answering({ harnessEnabled: true }))).toBeUndefined();
  });

  it('answers nothing when the network throws, rather than failing the drive', async () => {
    const dead: ConfigFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await fetchPlatformConfig(LINKED, dead)).toBeUndefined();
  });

  /** A hung settings endpoint must not hold a leased browser context for a drive that never starts. */
  it('gives up rather than waiting forever', async () => {
    const hangs: ConfigFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    expect(await fetchPlatformConfig(LINKED, hangs, 10)).toBeUndefined();
  });

  it('tolerates a trailing slash on the configured host', async () => {
    const doFetch = answering({ provider: 'jev' });
    await fetchPlatformConfig({ ...LINKED, RETICLE_CLOUD_URL: 'https://app.reticle.sh/' }, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      'https://app.reticle.sh/v1/model/config',
      expect.anything(),
    );
  });
});

describe('the grant end date', () => {
  it('reads an ISO date or a number, and drops anything else', async () => {
    const iso = await fetchPlatformConfig(
      LINKED,
      answering({
        provider: 'jev',
        credits: { used: 1, limit: 500, kind: 'trial', endsAt: '1970-01-02T00:00:00Z' },
      }),
    );
    expect(iso?.credits?.endsAt).toBe(86_400_000);
    const junk = await fetchPlatformConfig(
      LINKED,
      answering({ provider: 'jev', credits: { used: 1, limit: 500, endsAt: 'soon' } }),
    );
    expect(junk?.credits).toEqual({ used: 1, limit: 500 });
  });
});

describe("the platform's coverage gate", () => {
  it('reads harnessUnlocked, coverageScore and harnessLock, rounding the percent down', async () => {
    const got = await fetchPlatformConfig(
      LINKED,
      answering({
        provider: 'jev',
        harnessUnlocked: false,
        coverageScore: 0.799,
        harnessLock: { reason: 'Harness unlocks at 80%…', prompt: 'p', command: null },
      }),
    );
    expect(got?.gate).toEqual({
      unlocked: false,
      percent: 79,
      reason: 'Harness unlocks at 80%…',
      prompt: 'p',
    });
  });

  it('carries no gate from a platform that sends none', async () => {
    expect(
      (await fetchPlatformConfig(LINKED, answering({ provider: 'jev' })))?.gate,
    ).toBeUndefined();
  });
});

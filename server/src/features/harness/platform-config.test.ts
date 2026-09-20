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
    expect(got).toEqual({ provider: 'jev', harnessEnabled: true, harnessEntitled: true });
  });

  it('sends the platform key as a bearer, to the config path', async () => {
    const doFetch = answering({ provider: 'jev' });
    await fetchPlatformConfig(LINKED, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      'https://app.reticle.sh/v1/model/config',
      expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer rk_live_x' } }),
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
  it('reports entitlement apart from the switch', async () => {
    const got = await fetchPlatformConfig(
      LINKED,
      answering({ provider: 'jev', harnessEnabled: true, harnessEntitled: false }),
    );
    expect(got).toEqual({ provider: 'jev', harnessEnabled: true, harnessEntitled: false });
  });

  /** An older API reports neither field, and silence must not read as a refusal on either. */
  it('treats a missing harnessEntitled as entitled', async () => {
    const got = await fetchPlatformConfig(LINKED, answering({ provider: 'jev' }));
    expect(got?.harnessEntitled).toBe(true);
  });

  /** The platform's own default is on; a daemon reading absence as "off" would disable the feature. */
  it('treats a missing harnessEnabled as enabled', async () => {
    const got = await fetchPlatformConfig(LINKED, answering({ provider: 'jev' }));
    expect(got?.harnessEnabled).toBe(true);
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

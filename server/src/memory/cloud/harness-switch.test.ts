/**
 * Writing the harness switch back to the platform.
 *
 * The panel owns none of this state, so the only thing that makes the switch real is this write
 * landing. Every case below is one where getting it wrong would be invisible: a silent no-op, a
 * field the console never rendered being reset, or a privilege the daemon does not have.
 *
 * The method is asserted against what the PLATFORM registers, not against what this file happens to
 * send. Pinned the other way round it asserted PATCH for a release, stayed green, and the platform
 * — which serves only GET and PUT on this path — 404'd every write. A test that repeats the request
 * shape back to itself cannot fail while the feature is broken, which is the whole failure this
 * product exists to refuse.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import { writeHarnessSwitch, type SwitchFetch } from './harness-switch.js';

const ENV = { [ReticleEnv.CLOUD_URL]: 'https://api.test/', RETICLE_API_KEY: 'rk_live_x' };
const ok: SwitchFetch = () => Promise.resolve({ ok: true, status: 200 });

describe('writing the harness switch', () => {
  it('PUTs the config path with the desired state, the method the platform serves', async () => {
    const doFetch = vi.fn(ok);
    await writeHarnessSwitch(ENV, false, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      'https://api.test/v1/model/config',
      expect.objectContaining({ method: 'PUT' }),
    );
    const body: unknown = JSON.parse(String(doFetch.mock.calls[0]?.[1].body));
    expect(body).toEqual({ harnessEnabled: false });
  });

  it('sends ONLY the switch, so a provider set in the console survives', async () => {
    const doFetch = vi.fn(ok);
    await writeHarnessSwitch(ENV, true, doFetch);
    const body = JSON.parse(String(doFetch.mock.calls[0]?.[1].body)) as Record<string, unknown>;
    // PATCH semantics are the whole point: a panel that never rendered a provider must not reset one.
    expect(Object.keys(body)).toEqual(['harnessEnabled']);
  });

  it('names no project — the key is already scoped to one', async () => {
    const doFetch = vi.fn(ok);
    await writeHarnessSwitch(ENV, true, doFetch);
    const body = JSON.parse(String(doFetch.mock.calls[0]?.[1].body)) as Record<string, unknown>;
    // Naming a project would be asking for a privilege this credential does not have, and the
    // platform refuses it. Sending one anyway would turn a clean 200 into a 400 nobody sees.
    expect(body['projectId']).toBeUndefined();
  });

  it('carries the key as a bearer token', async () => {
    const doFetch = vi.fn(ok);
    await writeHarnessSwitch(ENV, true, doFetch);
    expect(doFetch.mock.calls[0]?.[1].headers['authorization']).toBe('Bearer rk_live_x');
  });

  it.each([
    ['there is no key', { [ReticleEnv.CLOUD_URL]: 'https://api.test' }],
    ['there is no platform', { RETICLE_API_KEY: 'rk_live_x' }],
  ])('does not call out when %s', async (_why, env) => {
    const doFetch = vi.fn(ok);
    expect(await writeHarnessSwitch(env, true, doFetch)).toBe(false);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the platform refuses', () => Promise.resolve({ ok: false, status: 403 })],
    ['the network is gone', () => Promise.reject(new Error('offline'))],
  ])('reports failure rather than throwing when %s', async (_why, doFetch) => {
    // A dev-only overlay must never surface a dialog because a settings write timed out. The next
    // snapshot re-reads the platform, so a lost write shows up as the switch springing back.
    expect(await writeHarnessSwitch(ENV, true, doFetch)).toBe(false);
  });
});

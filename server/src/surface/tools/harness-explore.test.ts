import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import type { ToolDeps } from './tools.js';
import {
  DEFAULT_MAX_STEPS,
  FINISH_TOOL,
  type ModelDriver,
  type ModelTurn,
} from '@/features/harness/harness.js';
import {
  exploreApp,
  harnessAvailable,
  maxStepsFromEnv,
  reconcileFlows,
  knownDriver,
  withLinkedCredential,
  MSG_NO_HARNESS_KEY,
  MSG_NO_JEV_KEY,
  MSG_NO_OPENAI_KEY,
} from './harness-explore.js';

/** One completed flow-save call, as the loop records it. */
const saveCall = (args: Record<string, unknown>, result: unknown, isError = false) => ({
  name: 'reticle_flow_save',
  args,
  result,
  isError,
});

/** A flow store that answers a list, which is the only part of `deps` exploring reads. */
function depsWithFlows(...lists: readonly string[][]): ToolDeps {
  let call = 0;
  return {
    flows: {
      list: () => {
        const answer = lists[Math.min(call, lists.length - 1)] ?? [];
        call += 1;
        return Promise.resolve([...answer]);
      },
    },
  } as unknown as ToolDeps;
}

function finishing(summary: string): ModelDriver {
  return {
    turn: (): Promise<ModelTurn> =>
      Promise.resolve({
        text: '',
        calls: [{ id: '1', name: FINISH_TOOL.name, args: { summary } }],
      }),
  };
}

describe('exploring an app', () => {
  it('reports the flows that now exist and did not before', async () => {
    const result = await exploreApp(
      depsWithFlows(['login'], ['login', 'checkout']),
      {},
      { driver: finishing('drove checkout'), skipPlatformConfig: true },
    );

    expect(result.savedFlows).toEqual(['checkout']);
    expect(result.drive.summary).toBe('drove checkout');
  });

  it('believes the disk and not the model about what was saved', async () => {
    const result = await exploreApp(
      depsWithFlows(['login'], ['login']),
      {},
      { driver: finishing('I saved a flow called checkout'), skipPlatformConfig: true },
    );

    // The model said it saved one. Nothing appeared. The answer is what is on disk.
    expect(result.savedFlows).toEqual([]);
  });

  it('refuses to invent a driver when no model is configured', async () => {
    await expect(exploreApp(depsWithFlows([]), {})).rejects.toThrow(MSG_NO_HARNESS_KEY);
  });

  it('is available exactly when a key is set', () => {
    expect(harnessAvailable({})).toBe(false);
    expect(harnessAvailable({ [ReticleEnv.HARNESS_KEY]: 'sk-x' })).toBe(true);
  });
});

describe('the step budget', () => {
  it('defaults when unset', () => {
    expect(maxStepsFromEnv({})).toBe(DEFAULT_MAX_STEPS);
  });

  it('is a budget somebody can actually change', () => {
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: '8' })).toBe(8);
  });

  it('ignores a value that would drive nothing, rather than reporting a run over an untouched app', () => {
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: '0' })).toBe(DEFAULT_MAX_STEPS);
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: 'lots' })).toBe(DEFAULT_MAX_STEPS);
  });
});

/**
 * The defect: a before/after name diff cannot see a flow being written over.
 *
 * A second drive of the same app records the same journeys under the same names, so `savedFlows`
 * came back empty and the tool told its caller that nothing was recorded and nothing would replay —
 * about a flow sitting on disk with ten steps in it. A false "nothing was verified" is the same
 * class of mistake as a false "everything passed", and this product does not get to make either.
 */
describe('reconciling what a drive left behind', () => {
  it('counts a brand new flow as saved', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in', 'checkout'],
      [saveCall({ flowName: 'checkout' }, { name: 'checkout' })],
    );
    expect(result.savedFlows).toEqual(['checkout']);
    expect(result.rewroteFlows).toEqual([]);
  });

  it('counts a flow that already existed and was written again', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'sign-in' }, { name: 'sign-in' })],
    );
    expect(result.savedFlows).toEqual([]);
    expect(result.rewroteFlows).toEqual(['sign-in']);
  });

  it('does not count a rewrite the store cannot confirm', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'checkout' }, { name: 'checkout' })],
    );
    expect(result.rewroteFlows).toEqual([]);
  });

  it('does not count a save that failed', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'sign-in' }, { error: 'no active recording' }, true)],
    );
    expect(result.rewroteFlows).toEqual([]);
  });

  it('follows saveAs, which is what names the file', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'rec-1', saveAs: 'sign-in' }, undefined)],
    );
    expect(result.rewroteFlows).toEqual(['sign-in']);
  });

  it('reports a rewrite once, however many times it was written', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [
        saveCall({ flowName: 'sign-in' }, { name: 'sign-in' }),
        saveCall({ flowName: 'sign-in' }, { name: 'sign-in' }),
      ],
    );
    expect(result.rewroteFlows).toEqual(['sign-in']);
  });
});

/**
 * Naming a driver is how a comparison attributes its result, so the two failure modes that would
 * make that attribution a lie are the ones pinned here: silently substituting another driver, and
 * reporting a name that is not the one that drove.
 */
describe('choosing which model drives', () => {
  const JEV_ENV = { JEV_API_KEY: 'j' };
  const BOTH = { JEV_API_KEY: 'j', ANTHROPIC_API_KEY: 'a' };

  it('defaults to anthropic when both are configured', async () => {
    const result = await exploreApp(depsWithFlows([]), BOTH, {
      maxSteps: 1,
      skipPlatformConfig: true,
    });
    expect(result.driverName).toBe('anthropic');
  });

  it('uses jev when it is the only one configured', async () => {
    const result = await exploreApp(depsWithFlows([]), JEV_ENV, {
      maxSteps: 1,
      skipPlatformConfig: true,
    });
    expect(result.driverName).toBe('jev');
  });

  it('honours a per-call request over the daemon default', async () => {
    const result = await exploreApp(depsWithFlows([]), BOTH, { maxSteps: 1, driverName: 'jev' });
    expect(result.driverName).toBe('jev');
  });

  it('honours the environment when no call names one', async () => {
    const result = await exploreApp(
      depsWithFlows([]),
      { ...BOTH, RETICLE_HARNESS_DRIVER: 'jev' },
      { maxSteps: 1, skipPlatformConfig: true },
    );
    expect(result.driverName).toBe('jev');
  });

  /** A substitution here would let an A/B measure the same driver twice and call it a comparison. */
  it('refuses a named driver it cannot build rather than substituting the other', async () => {
    await expect(
      exploreApp(depsWithFlows([]), { ANTHROPIC_API_KEY: 'a' }, { maxSteps: 1, driverName: 'jev' }),
    ).rejects.toThrow(MSG_NO_JEV_KEY);
  });

  it('refuses a driver it has never heard of', async () => {
    await expect(
      exploreApp(depsWithFlows([]), BOTH, { maxSteps: 1, driverName: 'gpt' }),
    ).rejects.toThrow('Unknown harness driver');
  });

  it('calls an injected driver custom, because it is not ours to name', async () => {
    const result = await exploreApp(
      depsWithFlows([]),
      {},
      { driver: finishing(''), skipPlatformConfig: true },
    );
    expect(result.driverName).toBe('custom');
  });
});

/**
 * A preference the daemon cannot honour is ignored; an instruction it cannot honour is refused.
 *
 * The platform offers providers a given daemon may be too old to know — it already offers `openai`,
 * which has no binding here. A stored preference is a statement about the account, so a daemon that
 * refused to drive because a web UI knew one more word than it does would be broken by its own
 * upgrade cycle. Naming a driver in the CALL is an instruction, and an unknown one still throws.
 */
describe('a stored preference this build cannot honour', () => {
  it('keeps a driver it has', () => {
    expect(knownDriver('jev')).toBe('jev');
    expect(knownDriver('anthropic')).toBe('anthropic');
    expect(knownDriver('openai')).toBe('openai');
  });

  /**
   * `openai` was the example here until this build grew a driver for it, which is the case this
   * asymmetry exists for: the platform offers providers a given daemon may not have yet, and the
   * daemon catches up later. The test moved to a name this build does not know rather than being
   * deleted, because the situation it describes did not go away — it just moved along one.
   */
  it('ignores one it does not have, rather than refusing to drive', () => {
    expect(knownDriver('a-provider-added-after-this-build')).toBeUndefined();
  });

  it('ignores an absent preference', () => {
    expect(knownDriver(undefined)).toBeUndefined();
  });

  /** The same word, asked for explicitly, is still an error — that is the asymmetry. */
  it('still refuses the same name when the CALL asks for it', async () => {
    await expect(
      exploreApp(
        depsWithFlows([]),
        { JEV_API_KEY: 'j' },
        { maxSteps: 1, skipPlatformConfig: true, driverName: 'a-provider-added-after-this-build' },
      ),
    ).rejects.toThrow('Unknown harness driver');
  });

  /** A driver this build HAS but has no key for is refused BY NAME, never quietly swapped. */
  it('refuses a known driver it cannot configure, rather than substituting', async () => {
    await expect(
      exploreApp(
        depsWithFlows([]),
        { JEV_API_KEY: 'j' },
        { maxSteps: 1, skipPlatformConfig: true, driverName: 'openai' },
      ),
    ).rejects.toThrow(MSG_NO_OPENAI_KEY);
  });
});

/**
 * The credential `reticle link` already filed.
 *
 * It mints a project-scoped key into `~/.reticle/credentials.json`, and the CLI has read it from
 * there for as long as it has existed. The harness read only `process.env` — so somebody who had
 * signed in, linked their project and been told they were connected still got "no model configured
 * to drive the app", and the only way out was to find the key in the console and export it by hand.
 */
describe('finding the key a linked machine already has', () => {
  const linked = (cloud: { url: string; apiKey: string } | null): ToolDeps =>
    ({ linkedCloud: () => Promise.resolve(cloud) }) as unknown as ToolDeps;

  const FILED = { url: 'https://app.reticle.sh', apiKey: 'rk_live_filed' };

  it('uses the filed credential when nothing is exported', async () => {
    const env = await withLinkedCredential(linked(FILED), {});
    expect(env['RETICLE_API_KEY']).toBe('rk_live_filed');
    expect(env['RETICLE_CLOUD_URL']).toBe('https://app.reticle.sh');
  });

  /** Someone who exported a key meant that key — and CI has no linked project to read. */
  it('leaves an explicitly exported key alone', async () => {
    const env = await withLinkedCredential(linked(FILED), { RETICLE_API_KEY: 'rk_live_exported' });
    expect(env['RETICLE_API_KEY']).toBe('rk_live_exported');
  });

  it('honours the legacy name as explicit too, rather than overwriting it', async () => {
    const env = await withLinkedCredential(linked(FILED), { RETICLE_CLOUD_KEY: 'rk_live_legacy' });
    expect(env['RETICLE_API_KEY']).toBeUndefined();
    expect(env['RETICLE_CLOUD_KEY']).toBe('rk_live_legacy');
  });

  it('keeps an explicitly named host, so a proxy is not overridden by the linked one', async () => {
    const env = await withLinkedCredential(linked(FILED), {
      RETICLE_CLOUD_URL: 'http://localhost:1',
    });
    expect(env['RETICLE_CLOUD_URL']).toBe('http://localhost:1');
  });

  it('changes nothing on a machine that was never linked', async () => {
    const env = await withLinkedCredential(linked(null), {});
    expect(env['RETICLE_API_KEY']).toBeUndefined();
  });

  /** An embedder with no filesystem supplies no port at all. Not linked, never an error. */
  it('changes nothing when the host supplies no resolver', async () => {
    const env = await withLinkedCredential({} as unknown as ToolDeps, {});
    expect(env['RETICLE_API_KEY']).toBeUndefined();
  });

  /** A credential store that cannot be read is "not linked", never a failed drive. */
  it('survives a resolver that throws', async () => {
    const angry = {
      linkedCloud: () => Promise.reject(new Error('unreadable')),
    } as unknown as ToolDeps;
    await expect(withLinkedCredential(angry, {})).resolves.toEqual({});
  });
});

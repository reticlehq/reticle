import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import type { ToolDeps } from './tools.js';
import {
  DEFAULT_MAX_STEPS,
  FINISH_TOOL,
  type ModelDriver,
  type ModelTurn,
  type ToolOutcome,
} from '@/features/harness/harness.js';
import {
  exploreApp,
  harnessAvailable,
  maxStepsFromEnv,
  reconcileFlows,
  openRecordingName,
  bankedIntent,
  withLinkedCredential,
  MSG_NO_HARNESS_KEY,
  MSG_HARNESS_DISABLED,
  MSG_HARNESS_UNCLAIMED,
  MSG_HARNESS_UNCONFIRMED,
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
  /**
   * The real drive this guards against saved `harness-drive-home`: one click, no `expect`, replayed
   * as "verified nothing" while the drive reported it as saved work. A saved flow that checks
   * nothing is named as such rather than counted as evidence.
   */
  it('names the saved flows that check nothing', async () => {
    const steps: Record<string, unknown[]> = {
      checkout: [{ action: 'click' }],
      login: [{ action: 'click', expect: { kind: 'text', contains: 'Welcome' } }],
    };
    let call = 0;
    const lists = [[], ['checkout', 'login']];
    const deps = {
      flows: {
        list: () => Promise.resolve([...(lists[Math.min(call++, 1)] ?? [])]),
        load: (name: string) =>
          Promise.resolve({ ok: true, value: { name, steps: steps[name] ?? [] } }),
      },
    } as unknown as ToolDeps;
    const result = await exploreApp(deps, {}, { driver: finishing(''), skipPlatformConfig: true });
    expect(result.savedFlows).toEqual(['checkout', 'login']);
    expect(result.unverifiedFlows).toEqual(['checkout']);
    // The run it syncs as, so the platform's chat can fold that run into the check it asked for.
    expect(result.runIds).toEqual([expect.stringMatching(/^harness-[0-9a-f-]{36}$/)]);
  });

  it('records the persona as the intent of a saved flow that has none, whoever saved it', async () => {
    const files: Record<
      string,
      { name: string; intent?: string; projectId?: string; steps: unknown[] }
    > = {
      checkout: { name: 'checkout', projectId: 'shop', steps: [{ action: 'click' }] },
      login: { name: 'login', intent: 'sign in works', steps: [] },
    };
    const saved: { name: string; intent?: string; project?: string | undefined }[] = [];
    let call = 0;
    const deps = {
      flows: {
        list: () => Promise.resolve(0 === call++ ? [] : ['checkout', 'login']),
        load: (name: string) => Promise.resolve({ ok: true, value: files[name] }),
        // The project rides along: without it the store writes a flat duplicate beside the original.
        saveFlow: (flow: { name: string; intent?: string }, project?: string) => {
          saved.push({ ...flow, project });
          return Promise.resolve({ ok: true, value: {} });
        },
      },
    } as unknown as ToolDeps;
    await exploreApp(
      deps,
      {},
      {
        driver: finishing(''),
        skipPlatformConfig: true,
        focus: 'a visitor who clicks the counter twice',
      },
    );
    expect(saved.map((f) => [f.name, f.intent, f.project])).toEqual([
      ['checkout', 'a visitor who clicks the counter twice', 'shop'],
    ]);
  });

  it('banks an open recording under the persona it was driving for', () => {
    expect(bankedIntent('a returning customer checking out', 'harness-drive-home')).toBe(
      'a returning customer checking out',
    );
    expect(bankedIntent(undefined, 'harness-drive-home')).toContain('harness-drive-home');
  });

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

  /** The Harness is the platform's: a model key of one's own no longer drives anything here. */
  it('is available only through the platform, never on a model key of your own', () => {
    expect(harnessAvailable({})).toBe(false);
    expect(harnessAvailable({ [ReticleEnv.HARNESS_KEY]: 'sk-x' })).toBe(false);
    expect(
      harnessAvailable({ [ReticleEnv.API_KEY]: 'rk_live_x', [ReticleEnv.CLOUD_URL]: 'https://p' }),
    ).toBe(true);
  });

  it('refuses a drive on a model key of your own, and says the Harness is on the platform', async () => {
    await expect(
      exploreApp(depsWithFlows([]), { [ReticleEnv.HARNESS_KEY]: 'sk-ant-own' }, { maxSteps: 1 }),
    ).rejects.toThrow(MSG_NO_HARNESS_KEY);
    expect(MSG_NO_HARNESS_KEY).toContain('reticle connect');
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

  /*
   * The same precedence as sync, `reticle push` and `reticle verify`: the resolved credential (the
   * stored key for the link's host, else the exported one) wins. It used to be the other way round
   * here only, so one machine could push with one key and drive with another.
   */
  it('prefers the resolved credential over an exported key, like every other caller', async () => {
    const env = await withLinkedCredential(linked(FILED), { RETICLE_API_KEY: 'rk_live_exported' });
    expect(env['RETICLE_API_KEY']).toBe('rk_live_filed');
  });

  it('uses the exported key when the resolver returns it, which is what CI sees', async () => {
    const env = await withLinkedCredential(linked(null), { RETICLE_CLOUD_KEY: 'rk_live_legacy' });
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

/**
 * Saving is not a decision, and not something a step budget gets to cut off.
 *
 * The driver reserves turns for its own teardown, which covers the ordinary ending. It does not
 * cover a drive that BROKE, or one whose model went quiet, or one cut short by a budget the caller
 * shortened — and in every one of those the app really was driven and the record of it was thrown
 * away. Measured before this existed: a 24-step journey through a real dashboard, saving nothing.
 *
 * What is pinned here is the DECISION — is a recording still open — because that is the part that
 * can be wrong. Whether the save then lands is the toolset's job, and a fake toolset would only
 * test the fake.
 */
describe('deciding whether a drive left a recording open', () => {
  const rec = (action: string, recordingName: string, isError = false): ToolOutcome => ({
    id: 'x',
    name: 'reticle_record',
    args: { action, recordingName },
    result: {},
    isError,
  });

  it('finds the recording a drive started and never closed', () => {
    expect(openRecordingName([rec('start', 'harness-drive-home')])).toBe('harness-drive-home');
  });

  it('finds nothing when the drive closed it properly', () => {
    expect(
      openRecordingName([rec('start', 'harness-drive-home'), rec('stop', 'harness-drive-home')]),
    ).toBeUndefined();
  });

  it('finds nothing when the drive never recorded at all', () => {
    expect(openRecordingName([])).toBeUndefined();
  });

  /** A start that was REFUSED opened nothing, so there is nothing to bank. */
  it('ignores a recording that failed to start', () => {
    expect(openRecordingName([rec('start', 'harness-drive-home', true)])).toBeUndefined();
  });

  /** One flow per page means several recordings per drive; only the last can still be open. */
  it('reports the one still open after several pages', () => {
    expect(
      openRecordingName([
        rec('start', 'harness-drive-home'),
        rec('stop', 'harness-drive-home'),
        rec('start', 'harness-drive-transactions'),
      ]),
    ).toBe('harness-drive-transactions');
  });

  /** A stop naming a DIFFERENT recording closes nothing — that is a mismatch, not a close. */
  it('does not treat a stop for another recording as closing this one', () => {
    expect(
      openRecordingName([rec('start', 'harness-drive-home'), rec('stop', 'something-else')]),
    ).toBe('harness-drive-home');
  });
});

/**
 * A switch that does not switch anything.
 *
 * `harnessEnabled` persisted on the platform, round-tripped through the API, and the daemon read it
 * and threw it away — so turning autonomous driving OFF changed a database value and nothing else.
 * Somebody turns it off, watches Reticle drive their app anyway, and is then right to distrust
 * every other control in the product.
 */
describe('turning the harness off', () => {
  /** The platform's answer, as the daemon reads it over the wire. */
  const platformSays = (body: Record<string, unknown>) => () =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

  const linked = { [ReticleEnv.API_KEY]: 'rk_live_x', [ReticleEnv.CLOUD_URL]: 'https://api.test' };

  it('refuses to drive, and says where to turn it back on', async () => {
    await expect(
      exploreApp(depsWithFlows([]), linked, {
        maxSteps: 1,
        driver: finishing(''),
        configFetch: platformSays({ provider: 'jev', harnessEnabled: false }),
      }),
    ).rejects.toThrow(MSG_HARNESS_DISABLED);
  });

  it('drives when the platform says the harness is on', async () => {
    const result = await exploreApp(depsWithFlows([]), linked, {
      maxSteps: 1,
      driver: finishing(''),
      configFetch: platformSays({ provider: 'jev', harnessEnabled: true }),
    });
    expect(result.drive).toBeDefined();
  });
});

/**
 * Entitlement is about WHOSE MONEY, and it is not the same question as the switch above.
 *
 * A drive through the platform proxy spends Reticle's model budget. Free for three months, included
 * on a paid plan, and otherwise nobody is paying for it. Told as "the harness is off" that becomes a
 * support ticket from somebody who never turned anything off, so it is refused in its own words —
 * and the Harness runs on nothing else: it is the platform's, on the workspace's credits.
 */
describe('a workspace with no entitlement', () => {
  const platformSays = (body: Record<string, unknown>) => () =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
  const unentitled = platformSays({
    provider: 'jev',
    harnessEnabled: true,
    harnessEntitled: false,
  });
  const linked = { [ReticleEnv.API_KEY]: 'rk_live_x', [ReticleEnv.CLOUD_URL]: 'https://api.test' };

  it('is pointed at its Harness credits, never at an offer that does not exist', async () => {
    await expect(
      exploreApp(depsWithFlows([]), linked, {
        maxSteps: 1,
        driver: finishing(''),
        configFetch: unentitled,
      }),
    ).rejects.toThrow(MSG_HARNESS_UNCLAIMED);
    // The free offer is switched off on the platform and the console has no claim button, so the
    // old "claim the free 3 months" sent people looking for something that is not there.
    expect(MSG_HARNESS_UNCLAIMED).not.toMatch(/free 3 months|claim/i);
    expect(MSG_HARNESS_UNCLAIMED).toContain('Settings → Plan');
  });

  /**
   * The gate used to FAIL OPEN: a platform that was slow for two seconds, or down, let the drive
   * run on Reticle's model budget with nobody's entitlement checked. A drive that would bill us
   * needs a confirmed yes.
   */
  const unreachable = () => Promise.reject(new Error('ETIMEDOUT'));
  it('refuses a drive on our budget when the platform cannot confirm it', async () => {
    await expect(
      exploreApp(depsWithFlows([]), linked, {
        maxSteps: 1,
        driver: finishing(''),
        configFetch: unreachable,
      }),
    ).rejects.toThrow(MSG_HARNESS_UNCONFIRMED);
  });

  /** An older platform reports neither field; silence must not read as a refusal. */
  it('drives when the platform says nothing about entitlement', async () => {
    const result = await exploreApp(depsWithFlows([]), linked, {
      maxSteps: 1,
      driver: finishing(''),
      configFetch: platformSays({ provider: 'jev' }),
    });
    expect(result.drive).toBeDefined();
  });
});

describe('what the explore tool says it needs', () => {
  it('says it runs on the platform, linked', async () => {
    const { EXPLORE_TOOLS } = await import('./explore-tools.js');
    const { EXPLORE_NEEDS } = await import('@/features/harness/drivers.js');
    const description = EXPLORE_TOOLS.map((t) => t.description).join(' ');
    expect(description).toContain(EXPLORE_NEEDS);
    expect(EXPLORE_NEEDS).toContain('reticle connect');
    expect(EXPLORE_NEEDS).not.toContain('API_KEY');
  });
});
